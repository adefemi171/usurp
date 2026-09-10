/**
 * Integration tests for the per-user drill-down.
 *
 * The visibility gate is the reason these run against a real database: it is a
 * join across `arena_members`, and the property under test is that three
 * different states — absent, hidden, anonymous — are indistinguishable.
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
} from "@usurp/protocol";
import { closeDb, getDb } from "./client.js";
import { ingest } from "./ingest.js";
import {
  issueEnrollment,
  redeemEnrollment,
  upsertUserByHandle,
} from "./enrollment.js";
import { arenaMembers, arenas, users } from "./schema.js";
import { joinGlobalArena } from "./seed.js";
import { derivedSignals, userProfile } from "./profile.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-09-08T13:59:00.000Z");

describe.skipIf(!hasDb)("userProfile", () => {
  const db = hasDb ? getDb() : (undefined as never);
  let userId: string;
  let deviceId: string;
  let handle: string;
  let keys: ReturnType<typeof generateDeviceKeyPair>;

  function bucket(overrides: Partial<Bucket> = {}): Bucket {
    const base = {
      hour: "2026-09-08T13:00:00Z",
      agent: "claude-code",
      model: "claude-opus-5",
      input_tokens: 100,
      output_tokens: 200,
      cache_write_tokens: 300,
      cache_read_tokens: 400,
      calls: 5,
      sessions_started: 4,
      sessions_completed: 3,
      sessions_abandoned: 1,
      edits_applied: 9,
      edits_reverted: 1,
      commits: 2,
      ...overrides,
    };
    return {
      ...base,
      cost_micros:
        overrides.cost_micros ??
        costMicros(base.model, {
          inputTokens: base.input_tokens,
          outputTokens: base.output_tokens,
          cacheWrite5mTokens: base.cache_write_tokens,
          cacheReadTokens: base.cache_read_tokens,
        }),
      dedupe_key:
        overrides.dedupe_key ??
        dedupeKey(deviceId, base.hour, base.agent, base.model),
    };
  }

  async function submit(buckets: Bucket[], seq: number) {
    const result = await ingest(
      db,
      signPayload(
        {
          v: PAYLOAD_VERSION,
          device_id: deviceId,
          seq,
          submitted_at: NOW.toISOString(),
          buckets,
        },
        keys.privateKeyPem,
      ),
      { now: NOW },
    );
    if (!result.ok)
      throw new Error(`ingest failed: ${JSON.stringify(result.rejected)}`);
    return result;
  }

  beforeEach(async () => {
    handle = `prof_${Math.random().toString(36).slice(2, 10)}`;
    const user = await upsertUserByHandle(db, handle);
    userId = user.id;
    await joinGlobalArena(db, userId);

    keys = generateDeviceKeyPair();
    const { code } = await issueEnrollment(db, userId, {});
    const redeemed = await redeemEnrollment(db, code, keys.publicKey);
    if (!redeemed.ok) throw new Error("enrollment failed");
    deviceId = redeemed.device.id;
  });

  afterEach(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  afterAll(async () => {
    await closeDb();
  });

  const setVisibility = (visibility: "public" | "anonymous" | "hidden") =>
    db
      .update(arenaMembers)
      .set({ visibility })
      .where(eq(arenaMembers.userId, userId));

  describe("the visibility gate", () => {
    it("club-only visibility does not publish a profile or private arena names globally", async () => {
      await db.delete(arenaMembers).where(eq(arenaMembers.userId, userId));
      const [club] = await db
        .insert(arenas)
        .values({
          type: "club",
          name: "Private profile club",
          slug: `private-${userId}`,
        })
        .returning();
      const friend = await upsertUserByHandle(
        db,
        `friend_${Math.random().toString(36).slice(2, 10)}`,
      );
      try {
        await db.insert(arenaMembers).values([
          { arenaId: club!.id, userId, visibility: "public" },
          { arenaId: club!.id, userId: friend.id, visibility: "hidden" },
        ]);
        expect(await userProfile(db, handle)).toBeUndefined();
        expect(
          (await userProfile(db, handle, { viewerId: friend.id }))?.arenas.map(
            (a) => a.slug,
          ),
        ).toContain(club!.slug);
        await joinGlobalArena(db, userId);
        expect(
          (await userProfile(db, handle))?.arenas.map((a) => a.slug),
        ).toEqual(["global"]);
      } finally {
        await db.delete(arenas).where(eq(arenas.id, club!.id));
        await db.delete(users).where(eq(users.id, friend.id));
      }
    });
    it.each(["anonymous", "hidden"] as const)(
      "allows only the owner of a %s profile",
      async (visibility) => {
        await submit([bucket()], 1);
        await setVisibility(visibility);
        const own = await userProfile(db, handle, {
          window: "all",
          now: NOW,
          viewerId: userId,
        });
        expect(own?.totals.calls).toBe(5);
        expect(own?.arenas).toEqual([]);
        expect(
          await userProfile(db, handle, { viewerId: "not-the-owner" }),
        ).toBeUndefined();
        expect(await userProfile(db, handle)).toBeUndefined();
      },
    );

    it("lets a new account see its own empty dashboard without joining an arena", async () => {
      await db.delete(arenaMembers).where(eq(arenaMembers.userId, userId));
      const own = await userProfile(db, handle, { viewerId: userId });
      expect(own?.handle).toBe(handle);
      expect(own?.usageSeries).toEqual([]);
      expect(own?.arenas).toEqual([]);
      expect(await userProfile(db, handle)).toBeUndefined();
      expect(
        await userProfile(db, handle, { viewerId: "not-the-owner" }),
      ).toBeUndefined();
    });

    it("serves a public member", async () => {
      await submit([bucket()], 1);
      const profile = await userProfile(db, handle, {
        window: "all",
        now: NOW,
      });
      expect(profile?.handle).toBe(handle);
    });

    it("refuses an anonymous member, so the pseudonym stays unlinkable", async () => {
      await submit([bucket()], 1);
      await setVisibility("anonymous");
      expect(
        await userProfile(db, handle, { window: "all", now: NOW }),
      ).toBeUndefined();
    });

    it("refuses a hidden member", async () => {
      await submit([bucket()], 1);
      await setVisibility("hidden");
      expect(
        await userProfile(db, handle, { window: "all", now: NOW }),
      ).toBeUndefined();
    });

    it("refuses a member who has left", async () => {
      await submit([bucket()], 1);
      await db
        .update(arenaMembers)
        .set({ status: "left" })
        .where(eq(arenaMembers.userId, userId));
      expect(
        await userProfile(db, handle, { window: "all", now: NOW }),
      ).toBeUndefined();
    });

    it("refuses a user with no arena membership at all", async () => {
      const orphan = await upsertUserByHandle(
        db,
        `orphan_${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        expect(
          await userProfile(db, orphan.handle, { window: "all", now: NOW }),
        ).toBeUndefined();
      } finally {
        await db.delete(users).where(eq(users.id, orphan.id));
      }
    });

    it("gives the same answer for absent as for hidden — no existence oracle", async () => {
      await setVisibility("hidden");
      const hidden = await userProfile(db, handle, { window: "all", now: NOW });
      const absent = await userProfile(db, "definitely_not_a_user", {
        window: "all",
        now: NOW,
      });
      expect(hidden).toBe(absent); // both undefined
    });

    it("names only the arenas the member is public in", async () => {
      await submit([bucket()], 1);
      const profile = await userProfile(db, handle, {
        window: "all",
        now: NOW,
      });
      expect(profile?.arenas.map((a) => a.slug)).toEqual(["global"]);
    });
  });

  describe("lookup", () => {
    it("is case-insensitive but returns the stored casing", async () => {
      await submit([bucket()], 1);
      const profile = await userProfile(db, handle.toUpperCase(), {
        window: "all",
        now: NOW,
      });
      expect(profile?.handle).toBe(handle);
    });
  });

  describe("aggregation", () => {
    it("provides the real daily model/agent distribution and preserves totals", async () => {
      await submit(
        [
          bucket(),
          bucket({ agent: "cursor" }),
          bucket({ hour: "2026-09-07T12:00:00Z" }),
        ],
        1,
      );
      const p = (await userProfile(db, handle, { window: "all", now: NOW }))!;
      expect(p.usageSeries).toHaveLength(3);
      expect(p.usageSeries.map((r) => `${r.day}:${r.agent}`)).toEqual([
        "2026-09-07:claude-code",
        "2026-09-08:claude-code",
        "2026-09-08:cursor",
      ]);
      expect(p.usageSeries.reduce((s, r) => s + r.effectiveTokens, 0)).toBe(
        p.totals.effectiveTokens,
      );
      expect(p.usageSeries.reduce((s, r) => s + r.costMicros, 0)).toBe(
        p.totals.costMicros,
      );
      expect(p.usageSeries[0]?.inputTokens).toBe(100);
      expect(p.usageSeries[0]?.unpricedBuckets).toBe(0);
    });

    it("labels unpriced and historical series while obeying the date window", async () => {
      await submit(
        [
          bucket({
            hour: "2026-05-05T13:00:00Z",
            historical: true,
            model: "unknown-model",
            cost_micros: 0,
          }),
        ],
        1,
      );
      const p = (await userProfile(db, handle, { window: "all", now: NOW }))!;
      expect(p.usageSeries[0]).toMatchObject({
        historicalBuckets: 1,
        unpricedBuckets: 1,
        costMicros: 0,
      });
      expect(
        (await userProfile(db, handle, { window: "week", now: NOW }))
          ?.usageSeries,
      ).toEqual([]);
    });

    it("totals the counters", async () => {
      await submit([bucket()], 1);
      const p = await userProfile(db, handle, { window: "all", now: NOW });

      expect(p?.totals).toMatchObject({
        effectiveTokens: 600, // 100 + 200 + 300; cache_read excluded
        cacheReadTokens: 400,
        calls: 5,
        sessionsStarted: 4,
        sessionsCompleted: 3,
        sessionsAbandoned: 1,
        editsApplied: 9,
        editsReverted: 1,
        commits: 2,
        activeHours: 1,
      });
      expect(p?.deviceCount).toBe(1);
    });

    it("breaks down by model, biggest first", async () => {
      await submit(
        [
          bucket(),
          bucket({
            model: "claude-sonnet-5",
            output_tokens: 5_000,
            dedupe_key: dedupeKey(
              deviceId,
              "2026-09-08T13:00:00Z",
              "claude-code",
              "claude-sonnet-5",
            ),
          }),
        ],
        1,
      );

      const p = await userProfile(db, handle, { window: "all", now: NOW });
      expect(p?.byModel.map((m) => m.model)).toEqual([
        "claude-sonnet-5",
        "claude-opus-5",
      ]);
      expect(p?.byModel[0]!.effectiveTokens).toBe(5_400);
    });

    it("keeps model usage separated by agent", async () => {
      await submit(
        [
          bucket(),
          bucket({
            agent: "cursor",
            dedupe_key: dedupeKey(
              deviceId,
              "2026-09-08T13:00:00Z",
              "cursor",
              "claude-opus-5",
            ),
          }),
        ],
        1,
      );

      const p = await userProfile(db, handle, { window: "all", now: NOW });
      expect(
        p?.byModelAgent.map((entry) => `${entry.agent}:${entry.model}`).sort(),
      ).toEqual(["claude-code:claude-opus-5", "cursor:claude-opus-5"]);
      expect(p?.byModel).toHaveLength(1);
    });

    it("groups days on UTC boundaries, not the server's timezone", async () => {
      // 23:00 UTC and 01:00 UTC are different days; in UTC-5 they would be the
      // same one, which is how a profile silently disagrees with its buckets.
      const late = "2026-09-07T23:00:00Z";
      const early = "2026-09-08T01:00:00Z";
      await submit(
        [
          bucket({
            hour: late,
            dedupe_key: dedupeKey(
              deviceId,
              late,
              "claude-code",
              "claude-opus-5",
            ),
          }),
          bucket({
            hour: early,
            dedupe_key: dedupeKey(
              deviceId,
              early,
              "claude-code",
              "claude-opus-5",
            ),
          }),
        ],
        1,
      );

      const p = await userProfile(db, handle, { window: "all", now: NOW });
      expect(p?.byDay.map((d) => d.day)).toEqual(["2026-09-08", "2026-09-07"]);
    });

    it("respects the window", async () => {
      const old = "2026-08-01T10:00:00Z";
      await submit(
        [
          bucket(),
          bucket({
            hour: old,
            dedupe_key: dedupeKey(
              deviceId,
              old,
              "claude-code",
              "claude-opus-5",
            ),
          }),
        ],
        1,
      );

      const all = await userProfile(db, handle, { window: "all", now: NOW });
      const week = await userProfile(db, handle, { window: "week", now: NOW });
      expect(all?.byDay).toHaveLength(2);
      expect(week?.byDay).toHaveLength(1);
    });

    it("returns a profile with zeroed totals when there is no usage", async () => {
      // A member who enrolled but never synced still has a page.
      const p = await userProfile(db, handle, { window: "all", now: NOW });
      expect(p).toBeDefined();
      expect(p?.totals.calls).toBe(0);
      expect(p?.byModel).toEqual([]);
      expect(p?.firstSeen).toBeNull();
    });
  });
});

describe("derivedSignals", () => {
  const base = {
    effectiveTokens: 1_000_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    sessionsAbandoned: 0,
    editsApplied: 0,
    editsReverted: 0,
    commits: 0,
    costMicros: 0,
    activeHours: 0,
  };

  it("measures cache reuse against re-caching, not against input", () => {
    // The definition the gates note argues for. `cache_read / (input +
    // cache_read)` would be ~1.0 here and carry no information.
    const s = derivedSignals({
      ...base,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
    });
    expect(s.cacheReuse).toBeCloseTo(0.8);
  });

  it("discriminates between a re-cacher and a reuser", () => {
    const thrash = derivedSignals({
      ...base,
      cacheReadTokens: 100,
      cacheWriteTokens: 900,
    });
    const clean = derivedSignals({
      ...base,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    });
    expect(thrash.cacheReuse).toBeCloseTo(0.1);
    expect(clean.cacheReuse).toBeCloseTo(0.9);
  });

  it("computes completion and yield", () => {
    const s = derivedSignals({
      ...base,
      sessionsStarted: 4,
      sessionsCompleted: 3,
      commits: 5,
    });
    expect(s.completion).toBeCloseTo(0.75);
    expect(s.yieldPerMTok).toBeCloseTo(5);
  });

  it("computes edit stickiness", () => {
    const s = derivedSignals({ ...base, editsApplied: 9, editsReverted: 1 });
    expect(s.editStickiness).toBeCloseTo(0.9);
  });

  it("returns null rather than NaN on an empty denominator", () => {
    const s = derivedSignals(base);
    expect(s.cacheReuse).toBeNull();
    expect(s.completion).toBeNull();
    expect(s.editStickiness).toBeNull();
  });

  it("returns null yield when there are no effective tokens", () => {
    expect(
      derivedSignals({ ...base, effectiveTokens: 0 }).yieldPerMTok,
    ).toBeNull();
  });
});
