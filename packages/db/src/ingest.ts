/**
 * The ingest path — `SPEC.md#3.4`, `#6.1`.
 *
 * Order matters, and it is the order below:
 *
 *   1. resolve the device        (who claims to be sending this)
 *   2. verify the signature      (are they actually that device)
 *   3. advance the seq counter   (is this a replay)
 *   4. run the plausibility gates(is the content possible)
 *   5. upsert with GREATEST      (merge, don't clobber, don't drop)
 *
 * Steps 2 and 3 must precede 4: gating an unsigned payload tells you nothing
 * about who sent it, and a replayed payload passes every content gate by
 * construction because it was valid the first time.
 */

import { and, eq, ne, or, sql, inArray } from "drizzle-orm";
import {
  runGates,
  verifyPayload,
  type GateViolation,
  type IngestPayload,
} from "@usurp/protocol";
import type { Db } from "./client.js";
import { devices, usageEvents, usageRepairBackups, usageBridgeSnapshots } from "./schema.js";

export type IngestFailure =
  | "unknown_device"
  | "device_revoked"
  | "bad_signature"
  | "stale_seq" | "stale_reader" | "invalid_repair";

export interface IngestRejection {
  bucketIndex: number;
  code: string;
  detail: string;
}

export interface IngestResult {
  ok: boolean;
  /** Set when the whole batch was refused, rather than individual buckets. */
  failure?: IngestFailure;
  accepted: number;
  rejected: IngestRejection[];
  flags: IngestRejection[];
  /**
   * The device's last accepted `seq`, returned on a `stale_seq` refusal.
   *
   * The counter lives in the CLI's `config.json` while the key lives in the OS
   * keychain, so the two can legitimately drift apart — a wiped home directory,
   * a restored backup, a second checkout. Without this the device would be
   * permanently unable to submit, because every guess below the server's value
   * is refused and the client has no way to learn the real one. Disclosing it
   * costs nothing: possession of the key is still required to use it.
   */
  lastSeq?: number;
}

function toRejections(violations: GateViolation[]): IngestRejection[] {
  return violations.map((v) => ({
    bucketIndex: v.bucketIndex,
    code: v.code,
    detail: v.detail,
  }));
}

/**
 * A stable 64-bit lock key from a device id.
 *
 * `#6.1` takes a per-arena advisory lock around the standings write for the
 * same reason we take a per-device one here: two `usurp sync` runs racing (a
 * `SessionEnd` hook firing while a manual sync is in flight) would otherwise
 * both read the same `last_seq` and both pass the monotonicity check.
 */
function deviceLockKey(deviceId: string): bigint {
  // FNV-1a, folded to a signed 64-bit range for `pg_advisory_xact_lock`.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(deviceId, "utf8")) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return BigInt.asIntN(64, hash);
}

export interface IngestOptions {
  /** Server clock, injected for deterministic tests. */
  now?: Date;
}

/**
 * Accept a signed batch.
 *
 * Runs in one transaction: either the counters, the `last_seq` advance, and the
 * `last_seen_at` touch all land, or none do. A partial apply would leave the
 * device's counter ahead of its stored data, permanently refusing the retry.
 */
export async function ingest(
  db: Db,
  payload: IngestPayload,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const now = options.now ?? new Date();

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${deviceLockKey(payload.device_id)})`);

    const [device] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, payload.device_id))
      .limit(1);

    if (!device) {
      return fail("unknown_device", "device_id is not registered");
    }
    if (device.revokedAt) {
      return fail("device_revoked", "this device has been revoked");
    }

    // ── The signature check. Everything after this point is attributable. ──
    if (!verifyPayload(payload, device.publicKey)) {
      // Deliberately not recorded as a row with `sig_ok = false`. That column
      // exists for the `unverified` tier's manual uploads (`#3.4`), which are
      // *expected* to be unsigned. A batch that claims a device and fails its
      // key is a forgery attempt, and storing it would let an attacker write to
      // another user's counters simply by being wrong.
      return fail("bad_signature", "signature does not verify against the device key");
    }

    // ── Replay protection. `#3.4`'s monotonic per-device counter. ──
    if (payload.seq <= device.lastSeq) {
      return {
        ...fail(
          "stale_seq",
          `seq ${payload.seq} is not ahead of the last accepted seq ${device.lastSeq}`,
        ),
        lastSeq: device.lastSeq,
      };
    }

    if ((payload.reader_revision ?? 1) < device.usageRevision) {
      return fail("stale_reader", "Update your CLI: this device has repaired usage accounting and cannot accept older readers.");
    }
    if (!payload.buckets.length && !payload.bridge) return fail("invalid_repair", "Empty submissions require a bridge snapshot.");
    if (payload.bridge && (Date.parse(payload.bridge.fetchedAt) > +now + 300_000 ||
      Date.parse(payload.bridge.fetchedAt) < +now - 3600_000)) return fail("invalid_repair", "Bridge snapshot must be freshly imported.");
    if (payload.replace_agents && (payload.reader_revision !== 2 ||
      payload.replace_agents.some(agent => !payload.buckets.some(b => b.agent === agent)))) {
      return fail("invalid_repair", "Repair requires revision 2 and a nonempty full snapshot for each selected agent.");
    }

    const gated = runGates(payload, { now });
    const rejectedIndexes = new Set(
      gated.rejects.filter((v) => v.bucketIndex >= 0).map((v) => v.bucketIndex),
    );

    /**
     * ── Duplicate backfill guard ────────────────────────────────────────────
     * `dedupe_key` is `sha256(device_id|hour|agent|model)` — deliberately
     * per-device, so two real machines working in the same hour both count.
     * But that also means re-enrolling *one* machine mints a new identity
     * whose `usurp sync --all` re-reads the same transcripts and books a
     * second row for every hour it already reported. Observed in testing:
     * three enrolments of one laptop put 832 calls on a board where the
     * transcripts held 425.
     *
     * The payload cannot distinguish the two cases — it is aggregate by
     * design (`#10.1`: no session ids), so the server has no per-call identity
     * to match on. What it *can* use is the enrolment boundary: a genuinely
     * new machine has no work predating its own enrolment, so a bucket that
     * both predates this device's `created_at` **and** is already covered by
     * another of the user's devices is a re-submission, not new work.
     *
     * Rejected rather than flagged: a flagged row is still stored and still
     * doubles the board, which is the harm being prevented.
     *
     * Known false positive: a second real machine used *before* usurp was
     * installed on it, in hours the first machine also worked. Its backfill
     * for those hours is refused. Rare, visible in `rejected[]`, and far
     * better than silently doubling someone's totals.
     */
    const backfillCutoff = device.createdAt;
    const suspectIndexes = payload.buckets
      .map((bucket, index) => ({ bucket, index }))
      .filter(
        ({ bucket, index }) =>
          !rejectedIndexes.has(index) && new Date(bucket.hour) < backfillCutoff,
      );

    const duplicateBackfill: IngestRejection[] = [];

    if (suspectIndexes.length > 0) {
      // One round trip for the whole batch, rather than one cross-region query
      // per hour. Match the same (hour, agent, model) scope as the old lookup.
      const clashes = await tx.select({ deviceId: usageEvents.deviceId,
        hour: usageEvents.hour, agent: usageEvents.agent, model: usageEvents.model })
        .from(usageEvents).where(and(eq(usageEvents.userId, device.userId),
          ne(usageEvents.deviceId, device.id), or(...suspectIndexes.map(({ bucket }) =>
            and(eq(usageEvents.hour, new Date(bucket.hour)), eq(usageEvents.agent, bucket.agent), eq(usageEvents.model, bucket.model))))));
      const clashKey = (hour: Date, agent: string, model: string) => JSON.stringify([hour.toISOString(), agent, model]);
      const byBucket = new Map(clashes.map(clash => [clashKey(clash.hour, clash.agent, clash.model), clash]));
      for (const { bucket, index } of suspectIndexes) {
        const clash = byBucket.get(clashKey(new Date(bucket.hour), bucket.agent, bucket.model));

        if (clash) {
          rejectedIndexes.add(index);
          duplicateBackfill.push({
            bucketIndex: index,
            code: "duplicate_backfill",
            detail:
              `${bucket.hour} predates this device's enrolment and is already reported by ` +
              `device ${clash.deviceId}. Re-enrolling a machine does not create new usage.`,
          });
        }
      }
    }

    // An envelope-level rejection (a clock or replay-window failure) condemns
    // the whole batch — there is no sensible subset to keep.
    if (gated.rejects.some((v) => v.bucketIndex < 0)) {
      return {
        ok: false,
        accepted: 0,
        rejected: toRejections(gated.rejects),
        flags: toRejections(gated.flags),
      };
    }

    const flagsByIndex = new Map<number, string[]>();
    for (const flag of gated.flags) {
      const list = flagsByIndex.get(flag.bucketIndex) ?? [];
      list.push(flag.code);
      flagsByIndex.set(flag.bucketIndex, list);
    }

    if (payload.replace_agents) {
      // All-or-nothing: never erase old history if ANY replacement was refused.
      if (rejectedIndexes.size) return fail("invalid_repair", "Repair aborted: replacement buckets failed validation; no data was changed.");
      const scope = and(eq(usageEvents.deviceId, device.id), inArray(usageEvents.agent, payload.replace_agents));
      const previous = await tx.select().from(usageEvents).where(scope);
      await tx.insert(usageRepairBackups).values({ deviceId: device.id, rows: previous });
      await tx.delete(usageEvents).where(scope);
      await tx.update(devices).set({ usageRevision: 2 }).where(eq(devices.id, device.id));
    }

    const rows: (typeof usageEvents.$inferInsert)[] = [];
    for (const [index, bucket] of payload.buckets.entries()) {
      if (rejectedIndexes.has(index)) continue;

      rows.push({
          userId: device.userId,
          deviceId: device.id,
          agent: bucket.agent,
          model: bucket.model,
          historical: bucket.historical ?? false,
          hour: new Date(bucket.hour),
          inputTokens: bucket.input_tokens,
          outputTokens: bucket.output_tokens,
          cacheWriteTokens: bucket.cache_write_tokens,
          cacheReadTokens: bucket.cache_read_tokens,
          calls: bucket.calls,
          sessionsStarted: bucket.sessions_started,
          sessionsCompleted: bucket.sessions_completed,
          sessionsAbandoned: bucket.sessions_abandoned,
          editsApplied: bucket.edits_applied,
          editsReverted: bucket.edits_reverted,
          commits: bucket.commits,
          costMicros: bucket.cost_micros,
          dedupeKey: bucket.dedupe_key,
          sigOk: true,
          flags: flagsByIndex.get(index) ?? [],
          submittedAt: now,
          updatedAt: now,
        });
    }
    const upsert = async (batch: (typeof usageEvents.$inferInsert)[]) => {
      await tx.insert(usageEvents).values(batch)
        /**
         * `GREATEST`, not `DO NOTHING` and not overwrite.
         *
         * A true replay carries identical values, so every `GREATEST` is a
         * no-op and `#3.4`'s "replays are no-ops" holds. But a re-read of a
         * partially observed hour legitimately carries *higher* counters — a
         * session that was still running when we first synced has since
         * finished — and `DO NOTHING` would drop that correction silently.
         *
         * Overwriting would be wrong in the other direction: a narrower
         * lookback window can produce a *smaller* honest count for the same
         * hour, which must not erase what we already know. Counters only grow
         * as more of an hour is observed, so max-merge is the only operation
         * that is both correct and idempotent.
         */
        .onConflictDoUpdate({
          target: usageEvents.dedupeKey,
          set: {
            inputTokens: sql`GREATEST(${usageEvents.inputTokens}, excluded.input_tokens)`,
            historical: sql`${usageEvents.historical} OR excluded.historical`,
            outputTokens: sql`GREATEST(${usageEvents.outputTokens}, excluded.output_tokens)`,
            cacheWriteTokens: sql`GREATEST(${usageEvents.cacheWriteTokens}, excluded.cache_write_tokens)`,
            cacheReadTokens: sql`GREATEST(${usageEvents.cacheReadTokens}, excluded.cache_read_tokens)`,
            calls: sql`GREATEST(${usageEvents.calls}, excluded.calls)`,
            sessionsStarted: sql`GREATEST(${usageEvents.sessionsStarted}, excluded.sessions_started)`,
            sessionsCompleted: sql`GREATEST(${usageEvents.sessionsCompleted}, excluded.sessions_completed)`,
            sessionsAbandoned: sql`GREATEST(${usageEvents.sessionsAbandoned}, excluded.sessions_abandoned)`,
            editsApplied: sql`GREATEST(${usageEvents.editsApplied}, excluded.edits_applied)`,
            editsReverted: sql`GREATEST(${usageEvents.editsReverted}, excluded.edits_reverted)`,
            commits: sql`GREATEST(${usageEvents.commits}, excluded.commits)`,
            costMicros: sql`GREATEST(${usageEvents.costMicros}, excluded.cost_micros)`,
            flags: sql`excluded.flags`,
            updatedAt: sql`excluded.updated_at`,
          },
        });

    };
    // Bound parameter counts. Repeated keys are flushed in original order so
    // max-merge and last-write flags keep their prior semantics; PostgreSQL
    // cannot update the same conflict key twice in one INSERT.
    let batch: (typeof usageEvents.$inferInsert)[] = [];
    const keys = new Set<string>();
    for (const row of rows) {
      if (batch.length === 200 || keys.has(row.dedupeKey)) {
        await upsert(batch); batch = []; keys.clear();
      }
      batch.push(row); keys.add(row.dedupeKey);
    }
    if (batch.length) await upsert(batch);

    if (payload.bridge) await tx.insert(usageBridgeSnapshots).values({ deviceId: device.id, snapshot: payload.bridge, importedAt: now })
      .onConflictDoUpdate({ target: usageBridgeSnapshots.deviceId,
        set: { snapshot: payload.bridge, importedAt: now },
        setWhere: sql`(${usageBridgeSnapshots.snapshot}->>'fetchedAt')::timestamptz <= ${payload.bridge.fetchedAt}::timestamptz` });

    await tx
      .update(devices)
      .set({ lastSeq: payload.seq, lastSeenAt: now })
      .where(eq(devices.id, device.id));

    return {
      ok: true,
      accepted: rows.length,
      rejected: [...toRejections(gated.rejects), ...duplicateBackfill],
      flags: toRejections(gated.flags),
    };
  });
}

function fail(failure: IngestFailure, detail: string): IngestResult {
  return {
    ok: false,
    failure,
    accepted: 0,
    rejected: [{ bucketIndex: -1, code: failure, detail }],
    flags: [],
  };
}

/**
 * Register a device against a one-time enrollment code.
 *
 * Re-registering a public key that already exists returns the existing device
 * rather than creating a second one, so a re-run of `usurp login` on the same
 * machine cannot reset `last_seq` to zero and reopen the replay window.
 */
export async function findDeviceByPublicKey(db: Db, publicKey: string) {
  const [device] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.publicKey, publicKey)))
    .limit(1);
  return device;
}
