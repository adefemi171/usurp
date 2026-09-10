/**
 * `usurp sync` — read, bucket, sign, submit.
 *
 * Designed to run from a Claude Code `SessionEnd` hook (`#3.2`), which sets the
 * constraints: quiet on success, never a stack trace, always exit 0 unless the
 * user asked for it interactively. A hook that prints a traceback because the
 * network blipped is a hook people uninstall.
 */

import { signPayload, PAYLOAD_VERSION, fetchBridgeSnapshot, type BridgeSnapshot, type Envelope } from "@usurp/protocol";
import { ApiClient } from "../api.js";
import { loadConfig, updateConfig } from "../config.js";
import { batchBuckets, collect, resolveSince, summarize } from "../collect.js";
import { KeystoreError, loadKey } from "../keystore.js";
import { bold, compactNumber, cyan, dim, error, info, success, usd, warn } from "../ui.js";

export interface SyncOptions {
  agentsview?: string;
  noBridge?: boolean;
  bridgeOnly?: boolean;
  api?: string;
  all?: boolean;
  repair?: boolean;
  noGit?: boolean;
  /** Suppress success output. Set by the hook wrapper. */
  quiet?: boolean;
  /**
   * Exit 0 even on failure. The hook uses this: a failed leaderboard sync must
   * never look like the user's session failed.
   */
  soft?: boolean;
  agents?: string[];
  onWarning?: (message: string) => void;
}

export async function sync(options: SyncOptions): Promise<number> {
  if (options.bridgeOnly && (options.noBridge || options.repair)) { error("--bridge-only cannot be combined with --no-bridge or --repair"); return 2; }
  if (options.repair && !options.all) { error("--repair requires --all", "Repairs must re-read complete history, not an incremental window."); return 2; }
  const config = await loadConfig();
  const fail = (code: number) => (options.soft ? 0 : code);

  if (!config.deviceId) {
    error("not logged in", "Run `usurp login <code>` first.");
    return fail(2);
  }

  let key;
  try {
    key = await loadKey(config.deviceId);
  } catch (err) {
    if (err instanceof KeystoreError) {
      error(err.message, err.hint);
      return fail(1);
    }
    throw err;
  }

  const now = new Date();
  let bridge: BridgeSnapshot | undefined;
  const bridgeUrl = options.noBridge ? undefined : options.agentsview ?? process.env.USURP_AGENTS_VIEW_URL ?? config.agentsviewUrl;
  if (bridgeUrl) {
    try { bridge = await fetchBridgeSnapshot(bridgeUrl); }
    catch { warn("AgentsView import unavailable or inconsistent. Keeping the previous snapshot; native sync continues."); }
  }
  if (options.bridgeOnly && !bridge) { error("No bridge snapshot available", "Pass --agentsview http://localhost:8080 and ensure AgentsView is running."); return fail(1); }
  const since = resolveSince({
    ...(config.lastSyncAt ? { lastSyncAt: config.lastSyncAt } : {}),
    ...(options.all ? { all: true } : {}),
    now,
  });

  const { buckets, warnings, reads } = options.bridgeOnly ? { buckets: [], warnings: [], reads: [] } : await collect({
    deviceId: config.deviceId,
    ...(options.all ? { all: true } : {}),
    ...(since ? { since } : {}),
    now,
    ...(options.noGit ? { noGit: true } : {}),
    ...(options.agents ? { agents: options.agents } : {}),
  });

  for (const message of warnings) { warn(message); options.onWarning?.(message); }

  const repairAgents = options.repair ? reads.filter(r => ["codex", "cursor"].includes(r.agent)).map(r => r.agent as "codex" | "cursor") : [];
  if (options.repair && (!repairAgents.length || buckets.length > 2000 ||
    reads.some(r => repairAgents.includes(r.agent as "codex" | "cursor") && r.result.warnings.some(w => /skipped Codex|could not read/.test(w))))) {
    error("repair aborted", "A complete, readable snapshot within the 2000-bucket atomic limit is required. Existing data was not changed."); return fail(1);
  }

  if (buckets.length === 0 && !bridge) {
    if (!options.quiet) info(dim("nothing new to sync"));
    // Still record the attempt, so the next run's overlap window is anchored.
    if (!options.all && !options.bridgeOnly) await updateConfig({ lastSyncAt: now.toISOString() });
    return bridgeUrl && !bridge ? fail(1) : 0;
  }

  const client = new ApiClient(options.api ?? config.apiUrl);

  // Keep requests below both the 2000-bucket schema limit and HTTP size cap.
  // Save sequence progress per batch; leave the sync cursor alone on failure
  // so rerunning safely repairs a partially imported archive.
  const batches = options.repair || !buckets.length ? [buckets] : batchBuckets(buckets);
  for (const [batchIndex, batch] of batches.entries()) {
    const send = async (seq: number) => {
      const envelope: Envelope = {
        v: PAYLOAD_VERSION,
        device_id: config.deviceId!,
        seq,
        submitted_at: now.toISOString(),
        buckets: batch,
        reader_revision: 2,
        ...(bridge && batchIndex === batches.length - 1 ? { bridge } : {}),
        ...(options.repair ? { replace_agents: repairAgents } : {}),
      };
      return client.ingest(signPayload(envelope, key.privateKeyPem));
    };

    let seq = (await loadConfig()).seq;
    let result = await send(seq);

    /**
     * Re-anchor a drifted counter.
     *
     * The key is in the keychain but `seq` is in `config.json`, so the two can
     * separate: a wiped home directory, a restored backup, a second checkout.
     * The server's refusal carries its `last_seq`, so we can resume exactly once
     * rather than either giving up or blindly probing upward.
     */
    if (!result.ok && result.error === "stale_seq" && typeof result.lastSeq === "number") {
      seq = result.lastSeq + 1;
      if (!options.quiet) {
        info(dim(`re-anchoring seq to ${seq} (local counter was behind the server)`));
      }
      result = await send(seq);
    }

    if (!result.ok) {
      switch (result.error) {
        case "network_error":
          // The single most common failure, and the least alarming.
          if (!options.quiet) warn(`could not reach ${options.api ?? config.apiUrl}`);
          return fail(1);
        case "unknown_device":
        case "bad_signature":
          error(
            "this device is not recognized by the server",
            "Run `usurp login <code>` to re-enrol.",
          );
          return fail(1);
        case "device_revoked":
          error("this device has been revoked", "Enrol again with a fresh code.");
          return fail(1);
        case "stale_seq":
          error("the server refused this batch as a replay", result.detail);
          return fail(1);
        default:
          error(`sync failed (${result.status}): ${result.error}`, result.detail);
          for (const issue of result.issues ?? []) {
            error(`  ${issue.path}: ${issue.message}`);
          }
          for (const rejection of result.rejected ?? []) {
            error(`  bucket ${rejection.bucketIndex}: ${rejection.detail}`);
          }
          return fail(1);
      }
    }

    await updateConfig({ seq: seq + 1 });

    const { accepted, rejected, flags } = result.data;
    const rejectedIndexes = new Set(rejected.map((r) => r.bucketIndex));
    const totals = summarize(batch.filter((_, i) => !rejectedIndexes.has(i)));

    if (!options.quiet && batch.length > 0) {
      success(
        `synced ${bold(String(accepted))} bucket${accepted === 1 ? "" : "s"} — ` +
          `${compactNumber(totals.effectiveTokens)} effective tokens, ${usd(totals.costMicros)}`,
      );
    }

    // Rejections and flags are always printed, quiet or not: they are the only
    // signal a user gets that their data is being refused or doubted.
    // Re-enrolled devices legitimately encounter history owned by their old
    // registration. The server has already retained it: do not retry forever
    // or prevent later batches (including the bridge snapshot) from arriving.
    const duplicates = rejected.filter(r => r.code === "duplicate_backfill");
    const failures = rejected.filter(r => r.code !== "duplicate_backfill");
    if (duplicates.length && !options.quiet) info(dim(`${duplicates.length} historical buckets already uploaded by another device registration; skipped without duplicating usage.`));
    for (const rejection of failures) {
      warn(`bucket ${rejection.bucketIndex} rejected (${rejection.code}): ${rejection.detail}`);
    }
    const groupedFlags = new Map<string, { count: number; code: string; detail: string }>();
    for (const flag of flags) {
      const key = `${flag.code}:${flag.detail}`;
      const group = groupedFlags.get(key) ?? { count: 0, code: flag.code, detail: flag.detail };
      group.count++; groupedFlags.set(key, group);
    }
    for (const flag of groupedFlags.values()) warn(`${flag.count} bucket(s) flagged (${flag.code}): ${flag.detail}`);
    if (failures.length) { options.onWarning?.(`${failures.length} usage buckets were rejected. Sync has not advanced.`); return fail(1); }
    if (flags.length) options.onWarning?.(`${flags.length} validation or pricing flags. Review data quality on your dashboard.`);

    if (!options.quiet && accepted > 0) {
      info(dim(`  ${cyan(`${(options.api ?? config.apiUrl).replace(/\/+$/, "")}/`)}`));
    }
  }

  // An archive import must not move the incremental cursor; it is independent
  // of the next regular sync and can be repeated without duplicating usage.
  if (!options.all && !options.bridgeOnly) await updateConfig({ lastSyncAt: now.toISOString() });
  if (bridge && bridgeUrl) {
    await updateConfig({ agentsviewUrl: bridgeUrl });
    if (!options.quiet) success(`AgentsView snapshot imported: ${bridge.rows.length} daily records, ${usd(bridge.rows.reduce((n, r) => n + r.costMicros, 0))} source-calculated usage cost. Not a bill.`);
  }

  return bridgeUrl && !bridge ? fail(1) : 0;
}
