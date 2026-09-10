/**
 * Integration tests for the ingest path, against a real Postgres.
 *
 * These need a database because the behaviour under test *is* the SQL: the
 * `GREATEST` upsert, the unique constraint on `dedupe_key`, and the advisory
 * lock. A mocked driver would assert that we wrote the query we wrote.
 *
 * Skipped when `DATABASE_URL` is unset, so the unit suite still runs on a
 * machine with no Docker.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  costMicros,
  dedupeKey,
  generateDeviceKeyPair,
  signPayload,
  PAYLOAD_VERSION,
  type Bucket,
  type Envelope,
} from "@usurp/protocol";
import { closeDb, getDb } from "./client.js";
import { ingest } from "./ingest.js";
import { issueEnrollment, redeemEnrollment, upsertUserByHandle } from "./enrollment.js";
import { devices, usageEvents, users, usageRepairBackups } from "./schema.js";
import { joinGlobalArena } from "./seed.js";
import { userProfile } from "./profile.js";
import { dailyMetrics } from "./rating.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-09-08T13:59:00.000Z");
const HOUR = "2026-09-08T13:00:00Z";

describe.skipIf(!hasDb)("ingest", () => {
  const db = hasDb ? getDb() : (undefined as never);
  let userId: string;
  let deviceId: string;
  let keys: ReturnType<typeof generateDeviceKeyPair>;
  let handle: string;

  function bucket(overrides: Partial<Bucket> = {}): Bucket {
    const base = {
      hour: HOUR,
      agent: "claude-code",
      model: "claude-opus-5",
      input_tokens: 100,
      output_tokens: 200,
      cache_write_tokens: 300,
      cache_read_tokens: 400,
      calls: 5,
      sessions_started: 1,
      sessions_completed: 1,
      sessions_abandoned: 0,
      edits_applied: 2,
      edits_reverted: 0,
      commits: 1,
      ...overrides,
    };
    return {
      ...base,
      // Derived, not hand-written: a literal here drifts from the pricing
      // table and shows up as a spurious `cost_mismatch` flag.
      cost_micros:
        overrides.cost_micros ??
        costMicros(base.model, {
          inputTokens: base.input_tokens,
          outputTokens: base.output_tokens,
          cacheWrite5mTokens: base.cache_write_tokens,
          cacheReadTokens: base.cache_read_tokens,
        }),
      dedupe_key:
        overrides.dedupe_key ?? dedupeKey(deviceId, base.hour, base.agent, base.model),
    };
  }

  function envelope(buckets: Bucket[], overrides: Partial<Envelope> = {}): Envelope {
    return {
      v: PAYLOAD_VERSION,
      device_id: deviceId,
      seq: 1,
      submitted_at: NOW.toISOString(),
      buckets,
      ...overrides,
    };
  }

  const submit = (env: Envelope, pem = keys.privateKeyPem) =>
    ingest(db, signPayload(env, pem), { now: NOW });

  const rows = () =>
    db.select().from(usageEvents).where(eq(usageEvents.deviceId, deviceId));

  it("repairs lower counters atomically, backs up old rows and refuses legacy readers", async () => {
    const original = bucket({ agent: "codex", input_tokens: 1000 });
    await submit(envelope([original, bucket()]));
    const corrected = bucket({ agent: "codex", input_tokens: 100 });
    const repair = envelope([corrected], { seq: 2, reader_revision: 2, replace_agents: ["codex"] });
    const tampered = signPayload(repair, keys.privateKeyPem);
    tampered.replace_agents = ["cursor"];
    expect((await ingest(db, tampered, { now: NOW })).failure).toBe("bad_signature");
    expect((await submit(repair)).ok).toBe(true);
    expect((await rows()).find(r => r.agent === "codex")?.inputTokens).toBe(100);
    expect((await rows()).find(r => r.agent === "claude-code")?.inputTokens).toBe(100);
    const backups = await db.select().from(usageRepairBackups).where(eq(usageRepairBackups.deviceId, deviceId));
    expect(backups).toHaveLength(1);
    expect(backups[0]?.rows).toHaveLength(1);
    expect((await submit(envelope([original], { seq: 3 }))).failure).toBe("stale_reader");
    expect((await submit(envelope([corrected], { seq: 3, reader_revision: 2 }))).ok).toBe(true);
    expect((await rows()).find(r => r.agent === "codex")?.inputTokens).toBe(100);
  });

  it("does not erase rows when any repaired bucket fails validation", async () => {
    await submit(envelope([bucket({ agent: "codex" })]));
    const invalid = bucket({ agent: "codex", calls: 0 });
    expect((await submit(envelope([invalid], { seq: 2, reader_revision: 2, replace_agents: ["codex"] }))).failure).toBe("invalid_repair");
    expect(await rows()).toHaveLength(1);
    expect(await db.select().from(usageRepairBackups).where(eq(usageRepairBackups.deviceId, deviceId))).toHaveLength(0);
  });

  beforeEach(async () => {
    handle = `test_${Math.random().toString(36).slice(2, 10)}`;
    const user = await upsertUserByHandle(db, handle);
    userId = user.id;
    await joinGlobalArena(db, userId);

    keys = generateDeviceKeyPair();
    const { code } = await issueEnrollment(db, userId, { label: "test" });
    const redeemed = await redeemEnrollment(db, code, keys.publicKey);
    if (!redeemed.ok) throw new Error(`enrollment failed: ${redeemed.failure}`);
    deviceId = redeemed.device.id;
  });

  afterEach(async () => {
    // Cascades through devices and usage_events.
    await db.delete(users).where(eq(users.id, userId));
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("happy path", () => {
    it("imports old history into analytics, idempotently, without competitive metrics", async () => {
      const old = bucket({ hour: "2024-01-01T09:00:00Z", historical: true });
      expect(await submit(envelope([old]))).toMatchObject({ ok: true, accepted: 1 });
      expect(await submit(envelope([old], { seq: 2 }))).toMatchObject({ ok: true, accepted: 1 });
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]?.historical).toBe(true);
      const profile = await userProfile(db, handle, { window: "all", now: NOW });
      expect(profile?.historicalBuckets).toBe(1);
      expect(profile?.totals.inputTokens).toBe(100);
      expect(profile?.byModelAgent[0]).toMatchObject({ agent: old.agent, model: old.model });
      expect((await userProfile(db, handle, { window: "week", now: NOW }))?.totals.calls).toBe(0);
      const metrics = await dailyMetrics(db, new Date("2024-01-01"), NOW);
      expect(metrics.filter(r => r.userId === userId)).toEqual([]);
    });

    it("cannot promote a historical bucket into competitive usage by resubmitting it", async () => {
      await submit(envelope([bucket({ historical: true })]));
      await submit(envelope([bucket()], { seq: 2 }));
      expect((await rows())[0]?.historical).toBe(true);
      const metrics = await dailyMetrics(db, new Date("2026-09-08"), NOW);
      expect(metrics.filter(r => r.userId === userId)).toEqual([]);
    });

    it("authenticates the historical flag as part of the signed bucket", async () => {
      const signed = signPayload(envelope([bucket()]), keys.privateKeyPem);
      signed.buckets[0]!.historical = true;
      expect(await ingest(db, signed, { now: NOW })).toMatchObject({ ok: false, failure: "bad_signature" });
      expect(await rows()).toHaveLength(0);
    });

    it("accepts a signed batch and stores the counters", async () => {
      const result = await submit(envelope([bucket()]));

      expect(result).toMatchObject({ ok: true, accepted: 1, rejected: [], flags: [] });

      const stored = await rows();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        userId,
        deviceId,
        agent: "claude-code",
        model: "claude-opus-5",
        inputTokens: 100,
        outputTokens: 200,
        cacheWriteTokens: 300,
        cacheReadTokens: 400,
        calls: 5,
        commits: 1,
        sigOk: true,
        flags: [],
      });
      expect(stored[0]!.hour.toISOString()).toBe("2026-09-08T13:00:00.000Z");
    });

    it("advances the device's seq and last_seen_at", async () => {
      await submit(envelope([bucket()], { seq: 7 }));

      const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
      expect(device!.lastSeq).toBe(7);
      expect(device!.lastSeenAt?.toISOString()).toBe(NOW.toISOString());
    });

    it("stores multiple buckets from one batch", async () => {
      const result = await submit(
        envelope([
          bucket(),
          bucket({
            hour: "2026-09-08T12:00:00Z",
            dedupe_key: dedupeKey(deviceId, "2026-09-08T12:00:00Z", "claude-code", "claude-opus-5"),
          }),
        ]),
      );

      expect(result.accepted).toBe(2);
      expect(await rows()).toHaveLength(2);
    });

    it("records non-fatal gate flags alongside the row", async () => {
      const result = await submit(envelope([bucket({ cost_micros: 1 })]));

      expect(result.ok).toBe(true);
      expect(result.flags.map((f) => f.code)).toContain("cost_mismatch");
      expect((await rows())[0]!.flags).toEqual(["cost_mismatch"]);
    });
  });

  describe("authentication", () => {
    it("refuses an unknown device", async () => {
      const result = await ingest(
        db,
        signPayload(envelope([bucket()], { device_id: "dev_nope" }), keys.privateKeyPem),
        { now: NOW },
      );

      expect(result).toMatchObject({ ok: false, failure: "unknown_device", accepted: 0 });
    });

    it("refuses a batch signed with the wrong key", async () => {
      const mallory = generateDeviceKeyPair();
      const result = await submit(envelope([bucket()]), mallory.privateKeyPem);

      expect(result).toMatchObject({ ok: false, failure: "bad_signature", accepted: 0 });
      // A forgery must not create a row under the impersonated device.
      expect(await rows()).toHaveLength(0);
    });

    it("refuses a batch whose contents were altered after signing", async () => {
      const signed = signPayload(envelope([bucket()]), keys.privateKeyPem);
      const tampered = {
        ...signed,
        buckets: [{ ...signed.buckets[0]!, output_tokens: 9_999_999 }],
      };

      const result = await ingest(db, tampered, { now: NOW });
      expect(result).toMatchObject({ ok: false, failure: "bad_signature" });
      expect(await rows()).toHaveLength(0);
    });

    it("refuses a revoked device", async () => {
      await db.update(devices).set({ revokedAt: NOW }).where(eq(devices.id, deviceId));
      const result = await submit(envelope([bucket()]));

      expect(result).toMatchObject({ ok: false, failure: "device_revoked" });
      expect(await rows()).toHaveLength(0);
    });
  });

  describe("replay protection", () => {
    it("refuses a verbatim replay", async () => {
      const payload = signPayload(envelope([bucket()]), keys.privateKeyPem);

      expect((await ingest(db, payload, { now: NOW })).accepted).toBe(1);
      // Same bytes again: the seq has not advanced.
      expect(await ingest(db, payload, { now: NOW })).toMatchObject({
        ok: false,
        failure: "stale_seq",
      });
    });

    it("refuses a seq that goes backwards", async () => {
      await submit(envelope([bucket()], { seq: 5 }));
      expect(await submit(envelope([bucket()], { seq: 4 }))).toMatchObject({
        failure: "stale_seq",
      });
      expect(await submit(envelope([bucket()], { seq: 5 }))).toMatchObject({
        failure: "stale_seq",
      });
    });

    it("accepts a strictly increasing seq", async () => {
      await submit(envelope([bucket()], { seq: 1 }));
      expect((await submit(envelope([bucket()], { seq: 2 }))).ok).toBe(true);
    });

    it("leaves the seq untouched when a batch is refused", async () => {
      await submit(envelope([bucket()], { seq: 3 }));
      const mallory = generateDeviceKeyPair();
      await submit(envelope([bucket()], { seq: 4 }), mallory.privateKeyPem);

      const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
      // A rejected forgery must not burn seq 4 for the legitimate device.
      expect(device!.lastSeq).toBe(3);
      expect((await submit(envelope([bucket()], { seq: 4 }))).ok).toBe(true);
    });
  });

  /**
   * The behaviour that made me correct the spec's "replays are no-ops" note.
   * A re-read of a partially observed hour carries higher counters, and the
   * upsert has to merge rather than ignore or clobber.
   */
  describe("GREATEST upsert", () => {
    it("bulk imports across chunk boundaries and preserves repeated-key max merge", async () => {
      const buckets = Array.from({ length: 250 }, (_, i) => bucket({
        hour: new Date(Date.parse(HOUR) - i * 3600_000).toISOString(),
      }));
      buckets.push(bucket({ hour: buckets[0]!.hour, calls: 9, input_tokens: 900 }));
      buckets.push(bucket({ hour: buckets[0]!.hour, calls: 2, input_tokens: 100 }));
      const result = await submit(envelope(buckets));
      expect(result).toMatchObject({ ok: true, accepted: 252, rejected: [] });
      const stored = await rows();
      expect(stored).toHaveLength(250);
      expect(stored.find(row => row.dedupeKey === buckets[0]!.dedupe_key)).toMatchObject({ calls: 9, inputTokens: 900 });
    });

    it("is a true no-op for identical values", async () => {
      await submit(envelope([bucket()], { seq: 1 }));
      const before = await rows();

      await submit(envelope([bucket()], { seq: 2 }));
      const after = await rows();

      expect(after).toHaveLength(1);
      expect(after[0]!.inputTokens).toBe(before[0]!.inputTokens);
      expect(after[0]!.calls).toBe(before[0]!.calls);
    });

    it("admits a late correction that raises a counter", async () => {
      // First sync: the session was still running, so no completion yet.
      await submit(envelope([bucket({ sessions_completed: 0, calls: 5 })], { seq: 1 }));
      expect((await rows())[0]).toMatchObject({ sessionsCompleted: 0, calls: 5 });

      // Re-read after the session finished.
      await submit(envelope([bucket({ sessions_completed: 1, calls: 9 })], { seq: 2 }));
      expect((await rows())[0]).toMatchObject({ sessionsCompleted: 1, calls: 9 });
    });

    it("never lets a narrower re-read erase what is already known", async () => {
      await submit(envelope([bucket({ calls: 9, input_tokens: 900 })], { seq: 1 }));
      // A shorter lookback window can honestly report less for the same hour.
      await submit(envelope([bucket({ calls: 2, input_tokens: 100 })], { seq: 2 }));

      expect((await rows())[0]).toMatchObject({ calls: 9, inputTokens: 900 });
    });

    it("keeps one row per dedupe_key however many times it is submitted", async () => {
      for (let seq = 1; seq <= 4; seq++) {
        await submit(envelope([bucket({ calls: seq })], { seq }));
      }
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0]!.calls).toBe(4);
    });
  });

  describe("gates", () => {
    it("stores the good buckets and reports only the bad ones", async () => {
      const result = await submit(
        envelope([
          bucket(),
          // Physically impossible: 2M tokens of context in one call.
          bucket({
            hour: "2026-09-08T12:00:00Z",
            calls: 1,
            input_tokens: 2_000_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            dedupe_key: dedupeKey(deviceId, "2026-09-08T12:00:00Z", "claude-code", "claude-opus-5"),
          }),
        ]),
      );

      expect(result.accepted).toBe(1);
      expect(result.rejected.map((r) => r.code)).toEqual(["context_window_exceeded"]);
      expect(await rows()).toHaveLength(1);
    });

    it("refuses the whole batch on an envelope-level violation", async () => {
      const result = await submit(
        envelope([bucket()], { submitted_at: "2026-09-01T00:00:00.000Z" }),
      );

      expect(result.ok).toBe(false);
      expect(result.rejected.map((r) => r.code)).toContain("submission_too_old");
      expect(await rows()).toHaveLength(0);
    });

    it("refuses a bucket whose dedupe_key belongs to another device", async () => {
      const result = await submit(
        envelope([bucket({ dedupe_key: dedupeKey("dev_victim", HOUR, "claude-code", "claude-opus-5") })]),
      );

      expect(result.accepted).toBe(0);
      expect(result.rejected.map((r) => r.code)).toEqual(["dedupe_key_mismatch"]);
    });
  });

  describe("duplicate backfill guard", () => {
    it("counts overlapping history from separate installations but not a re-enrollment", async () => {
      const installationA = "12345678-1234-4123-8123-123456789abc";
      const installationB = "22345678-1234-4123-8123-123456789abc";
      expect((await submit(envelope([bucket()], { installation_id: installationA }))).accepted).toBe(1);
      for (const [installation, accepted] of [[installationB, 1], [installationA, 0]] as const) {
        const next = await secondDeviceFor(userId, new Date("2026-09-08T20:00:00Z"));
        const result = await ingest(db, signPayload({ v: 1, device_id: next.deviceId, seq: 1, submitted_at: NOW.toISOString(), installation_id: installation,
          buckets: [{ ...bucket(), dedupe_key: dedupeKey(next.deviceId, HOUR, "claude-code", "claude-opus-5") }] }, next.keys.privateKeyPem), { now: NOW });
        expect(result.accepted).toBe(accepted);
      }
      expect(await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).toHaveLength(2);
      expect((await submit(envelope([bucket()], { seq: 2, installation_id: installationB }))).failure).toBe("invalid_repair");
      const tampered = signPayload(envelope([bucket()], { seq: 2, installation_id: installationA }), keys.privateKeyPem);
      tampered.installation_id = installationB;
      expect((await ingest(db, tampered, { now: NOW })).failure).toBe("bad_signature");
    });
    /**
     * The bug this exists for: `dedupe_key` is per-device, so re-enrolling one
     * machine mints a new identity whose `sync --all` re-reads the same
     * transcripts and books a second row for every hour. Observed on real
     * data: three enrolments of one laptop put 832 calls on a board where the
     * transcripts held 425.
     */
    async function secondDeviceFor(userId: string, createdAt: Date) {
      const keys = generateDeviceKeyPair();
      const { code } = await issueEnrollment(db, userId, { label: "second" });
      const redeemed = await redeemEnrollment(db, code, keys.publicKey);
      if (!redeemed.ok) throw new Error(redeemed.failure);
      // Enrolled *after* the usage it will try to backfill.
      await db
        .update(devices)
        .set({ createdAt })
        .where(eq(devices.id, redeemed.device.id));
      return { deviceId: redeemed.device.id, keys };
    }

    it("refuses pre-enrolment hours another device already reported", async () => {
      // Device one reports the hour.
      await submit(envelope([bucket()]));
      expect(await rows()).toHaveLength(1);

      // A re-enrolment of the same machine, created after that hour.
      const second = await secondDeviceFor(userId, new Date("2026-09-08T20:00:00.000Z"));

      const result = await ingest(
        db,
        signPayload(
          {
            v: PAYLOAD_VERSION,
            device_id: second.deviceId,
            seq: 1,
            submitted_at: NOW.toISOString(),
            buckets: [
              {
                ...bucket(),
                dedupe_key: dedupeKey(second.deviceId, HOUR, "claude-code", "claude-opus-5"),
              },
            ],
          },
          second.keys.privateKeyPem,
        ),
        { now: NOW },
      );

      expect(result.accepted).toBe(0);
      expect(result.rejected.map((r) => r.code)).toContain("duplicate_backfill");

      // The board must not have doubled.
      const stored = await db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.userId, userId));
      expect(stored).toHaveLength(1);
    });

    it("accepts a new device's own post-enrolment work", async () => {
      await submit(envelope([bucket()]));

      // Enrolled *before* the hour it reports — genuinely new work.
      const second = await secondDeviceFor(userId, new Date("2026-09-08T00:00:00.000Z"));
      const laterHour = "2026-09-08T15:00:00Z";

      const result = await ingest(
        db,
        signPayload(
          {
            v: PAYLOAD_VERSION,
            device_id: second.deviceId,
            seq: 1,
            submitted_at: "2026-09-08T15:59:00.000Z",
            buckets: [
              {
                ...bucket({ hour: laterHour }),
                dedupe_key: dedupeKey(second.deviceId, laterHour, "claude-code", "claude-opus-5"),
              },
            ],
          },
          second.keys.privateKeyPem,
        ),
        { now: new Date("2026-09-08T16:00:00.000Z") },
      );

      expect(result.accepted).toBe(1);
    });

    it("lets a second real machine report the same hour it is live for", async () => {
      // Two machines genuinely working in the same hour must both count —
      // which is why the guard keys on the enrolment boundary, not on overlap.
      await submit(envelope([bucket()]));

      const second = await secondDeviceFor(userId, new Date("2026-09-08T00:00:00.000Z"));

      const result = await ingest(
        db,
        signPayload(
          {
            v: PAYLOAD_VERSION,
            device_id: second.deviceId,
            seq: 1,
            submitted_at: NOW.toISOString(),
            buckets: [
              {
                ...bucket(),
                dedupe_key: dedupeKey(second.deviceId, HOUR, "claude-code", "claude-opus-5"),
              },
            ],
          },
          second.keys.privateKeyPem,
        ),
        { now: NOW },
      );

      expect(result.accepted).toBe(1);
      expect(await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).toHaveLength(2);
    });
  });

  describe("concurrency", () => {
    it("serializes racing syncs so only one wins a given seq", async () => {
      // The `SessionEnd` hook firing while a manual sync is in flight.
      const a = signPayload(envelope([bucket({ calls: 5 })], { seq: 1 }), keys.privateKeyPem);
      const b = signPayload(envelope([bucket({ calls: 7 })], { seq: 1 }), keys.privateKeyPem);

      const results = await Promise.all([
        ingest(db, a, { now: NOW }),
        ingest(db, b, { now: NOW }),
      ]);

      // Exactly one advanced the counter; the other saw a stale seq.
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => r.failure === "stale_seq")).toHaveLength(1);
      expect(await rows()).toHaveLength(1);
    });
  });
});
