import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { dedupeKey, runGates, type Bucket } from "@usurp/protocol";
import type { Db } from "./client.js";
import { devices, usageEvents } from "./schema.js";

/** Manual imports are analytics-only and can never acquire a signature or rating. */
export async function importManual(
  db: Db,
  userId: string,
  buckets: Bucket[],
  now = new Date(),
) {
  if (!buckets.length || buckets.length > 1000)
    throw new Error("invalid_batch_size");
  const deviceId = `manual_${userId}`;
  const normalized = buckets.map((b) => ({
    ...b,
    historical: true as const,
    dedupe_key: dedupeKey(deviceId, b.hour, b.agent, b.model),
  }));
  const gates = runGates(
    {
      v: 1,
      device_id: deviceId,
      seq: 1,
      submitted_at: now.toISOString(),
      buckets: normalized,
    },
    { now },
  );
  if (gates.rejects.length) return { accepted: 0, rejected: gates.rejects };
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${deviceId},0))`,
    );
    await tx
      .insert(devices)
      .values({
        id: deviceId,
        userId,
        publicKey: randomBytes(32).toString("base64url"),
        label: "Manual JSON imports",
        trustTier: "unverified",
      })
      .onConflictDoNothing();
    const [device] = await tx
      .select()
      .from(devices)
      .where(eq(devices.id, deviceId));
    if (device?.revokedAt) throw new Error("device_revoked");
    let accepted = 0;
    for (const [i, b] of normalized.entries()) {
      const [existing] = await tx
        .select({ id: usageEvents.deviceId })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.userId, userId),
            eq(usageEvents.agent, b.agent),
            eq(usageEvents.model, b.model),
            eq(usageEvents.hour, new Date(b.hour)),
          ),
        );
      if (existing) continue;
      await tx
        .insert(usageEvents)
        .values({
          userId,
          deviceId,
          agent: b.agent,
          model: b.model,
          hour: new Date(b.hour),
          historical: true,
          inputTokens: b.input_tokens,
          outputTokens: b.output_tokens,
          cacheWriteTokens: b.cache_write_tokens,
          cacheReadTokens: b.cache_read_tokens,
          calls: b.calls,
          sessionsStarted: b.sessions_started,
          sessionsCompleted: b.sessions_completed,
          sessionsAbandoned: b.sessions_abandoned,
          editsApplied: b.edits_applied,
          editsReverted: b.edits_reverted,
          commits: b.commits,
          costMicros: b.cost_micros,
          dedupeKey: b.dedupe_key,
          sigOk: false,
          flags: [
            "manual_unverified",
            ...gates.flags
              .filter((f) => f.bucketIndex === i)
              .map((f) => f.code),
          ],
        });
      accepted++;
    }
    return { accepted, rejected: [], skipped: normalized.length - accepted };
  });
}
