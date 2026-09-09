/**
 * `usurp preview` — print exactly what `sync` would send, without sending it.
 *
 * `#10` publishes the payload schema as a privacy commitment. A commitment you
 * can verify on your own machine, against your own data, is worth more than one
 * in a README — so this runs the same `collect()` the real sync does and can
 * emit the literal signed JSON with `--json`.
 */

import { signPayload, PAYLOAD_VERSION, isKnownModel, fetchBridgeSnapshot, type BridgeSnapshot, type Envelope } from "@usurp/protocol";
import { loadConfig } from "../config.js";
import { batchBuckets, collect, resolveSince, summarize } from "../collect.js";
import { loadKey } from "../keystore.js";
import { bold, compactNumber, dim, info, reserveStdoutForData, usd, warn } from "../ui.js";

export interface PreviewOptions {
  agentsview?: string;
  noBridge?: boolean;
  bridgeOnly?: boolean;
  all?: boolean;
  noGit?: boolean;
  /** Emit the signed payload as JSON. Requires a device key. */
  json?: boolean;
}

export async function preview(options: PreviewOptions): Promise<number> {
  // With --json, stdout is the payload; warnings must not corrupt it.
  if (options.json) reserveStdoutForData();

  const config = await loadConfig();
  // A preview must work before login, so that someone can inspect the payload
  // before deciding to enrol at all.
  const deviceId = config.deviceId ?? "dev_preview";
  const now = new Date();
  let bridge: BridgeSnapshot | undefined;
  const bridgeUrl = options.noBridge ? undefined : options.agentsview ?? process.env.USURP_AGENTS_VIEW_URL ?? config.agentsviewUrl;
  if (bridgeUrl) {
    try { bridge = await fetchBridgeSnapshot(bridgeUrl); }
    catch { warn("AgentsView preview unavailable. No snapshot would be uploaded; the server would retain its previous snapshot."); }
  }
  if (options.bridgeOnly && !bridge) return 1;

  const since = resolveSince({
    ...(config.lastSyncAt ? { lastSyncAt: config.lastSyncAt } : {}),
    ...(options.all ? { all: true } : {}),
    now,
  });

  const { buckets, reads, warnings } = options.bridgeOnly ? { buckets: [], reads: [], warnings: [] } : await collect({
    deviceId,
    ...(options.all ? { all: true } : {}),
    ...(since ? { since } : {}),
    now,
    ...(options.noGit ? { noGit: true } : {}),
  });

  for (const message of warnings) warn(message);

  if (options.json) {
    const envelope: Envelope = {
      v: PAYLOAD_VERSION,
      device_id: deviceId,
      seq: config.seq,
      submitted_at: now.toISOString(),
      reader_revision: 2,
      buckets,
    };

    if (buckets.length === 0 && !bridge) {
      process.stdout.write(`${JSON.stringify({ ...envelope, buckets: [] }, null, 2)}\n`);
      return 0;
    }

    const key = config.deviceId ? await loadKey(config.deviceId) : undefined;
    const batches = buckets.length ? batchBuckets(buckets) : [[]];
    for (const [index, batch] of batches.entries()) {
      const item = { ...envelope, seq: config.seq + index, buckets: batch,
        ...(bridge && index === batches.length - 1 ? { bridge } : {}) };
      const payload = key ? signPayload(item, key.privateKeyPem) : item;
      // Preserve single-payload JSON; large imports use one envelope per line.
      process.stdout.write(`${JSON.stringify(payload, null, batches.length === 1 ? 2 : undefined)}\n`);
    }
    return 0;
  }

  info("");
  info(bold("This is the complete set of data that would leave this machine:"));
  if (bridge) {
    info("AgentsView daily analytics snapshot (separate from native hourly counters):");
    info(JSON.stringify(bridge, null, 2));
  }
  if (options.all) info("Archive import: buckets older than 90 days are analytics-only (no rating or streak credit).");
  info("");

  if (buckets.length === 0) {
    info(dim(bridge ? "  No additional native hourly buckets." : "  (nothing — no agent activity in the window)"));
    info("");
    return 0;
  }

  const rows = buckets.map((b) => ({
    hour: b.hour.replace("T", " ").replace(":00:00Z", ""),
    agent: b.agent,
    model: b.model,
    calls: b.calls ? String(b.calls) : "unavailable",
    eff: b.calls ? compactNumber(b.input_tokens + b.output_tokens + b.cache_write_tokens) : "unavailable",
    read: b.calls ? compactNumber(b.cache_read_tokens) : "unavailable",
    sess: `${b.sessions_started}/${b.sessions_completed}/${b.sessions_abandoned}`,
    edits: `${b.edits_applied}/${b.edits_reverted}`,
    commits: String(b.commits),
    cost: !b.calls ? "unavailable" : !isKnownModel(b.model) ? "unpriced" : usd(b.cost_micros),
  }));

  const headers = {
    hour: "HOUR (UTC)",
    agent: "AGENT",
    model: "MODEL",
    calls: "CALLS",
    eff: "EFFECTIVE",
    read: "CACHE RD",
    sess: "SESS s/c/a",
    edits: "EDITS a/r",
    commits: "COMMITS",
    cost: "COST",
  } as const;

  const widths = Object.fromEntries(
    Object.keys(headers).map((k) => {
      const key = k as keyof typeof headers;
      return [key, Math.max(headers[key].length, ...rows.map((r) => r[key].length))];
    }),
  ) as Record<keyof typeof headers, number>;

  const order = Object.keys(headers) as Array<keyof typeof headers>;
  const line = (cells: Record<keyof typeof headers, string>) =>
    order.map((k) => cells[k].padEnd(widths[k])).join("  ");

  info(`  ${dim(line(headers))}`);
  for (const row of rows) info(`  ${line(row)}`);

  const totals = summarize(buckets);
  info("");
  info(
    `  ${bold(String(buckets.length))} bucket${buckets.length === 1 ? "" : "s"}, ` +
      `${compactNumber(totals.effectiveTokens)} effective tokens, ` +
      `${totals.calls} calls, ${usd(totals.costMicros)}`,
  );

  const read = reads.map((r) => `${r.agent} (${r.result.calls.length} calls)`).join(", ");
  info(dim(`  read from: ${read || "no agents detected"}`));
  if (since) info(dim(`  window: since ${since.toISOString()}`));
  info("");
  info(dim("  Not included, and never transmitted: prompts, completions, code,"));
  info(dim("  file paths, repo names, branch names, cwd, session ids, tool arguments."));
  info(dim("  Run with --json to see the exact bytes."));
  info("");

  return 0;
}
