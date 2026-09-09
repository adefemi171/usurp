/**
 * Integration tests for the rating recompute — `SPEC.md#6.1`.
 *
 * Database-backed because the behaviour under test is the SQL and the
 * transaction boundaries: the per-arena advisory lock, the append-only reign
 * history, and the day-ordered decay replay.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import { arenaMembers, arenas, dailyScores, events, reigns, standings, users } from "./schema.js";
import { recomputeStandings, seasonStandings } from "./rating.js";
import { ratingBoard } from "./rating.js";
import { ensureCurrentSeason, seasonDays, startOfUtcDay, addDays, SEASON_LENGTH_DAYS } from "./seasons.js";
import { titleForRank } from "./titles.js";
import { signInWithOAuth } from "./auth.js";
import { setVisibility } from "./arenas.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-09-20T12:00:00.000Z");

describe("titleForRank", () => {
  it("names the top three positions", () => {
    expect(titleForRank(1, 10)).toBe("sovereign");
    expect(titleForRank(2, 10)).toBe("usurper");
    expect(titleForRank(3, 10)).toBe("contender");
    expect(titleForRank(4, 10)).toBe("contender");
    expect(titleForRank(5, 10)).toBeUndefined();
  });

  it("withholds titles in an arena too small for them to mean anything", () => {
    // "Sovereign" of two people is just "the other one".
    expect(titleForRank(1, 2)).toBeUndefined();
    expect(titleForRank(1, 1)).toBeUndefined();
    expect(titleForRank(1, 3)).toBe("sovereign");
  });
});

describe.skipIf(!hasDb)("rating (database)", () => {
  const db = hasDb ? getDb() : (undefined as never);
  const createdUsers: string[] = [];
  const createdArenas: string[] = [];

  afterEach(async () => {
    for (const id of createdArenas.splice(0)) {
      await db.delete(arenas).where(eq(arenas.id, id));
    }
    for (const id of createdUsers.splice(0)) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  async function newUser(handle?: string) {
    const { user } = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: `rt_${Math.random().toString(36).slice(2, 12)}`,
      username: handle ?? `rt${Math.random().toString(36).slice(2, 10)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  async function newArena(memberIds: string[]) {
    const [arena] = await db
      .insert(arenas)
      .values({
        type: "club",
        name: "Rating Test",
        slug: `rt-${Math.random().toString(36).slice(2, 10)}`,
        maxMembers: 50,
      })
      .returning();
    createdArenas.push(arena!.id);

    for (const userId of memberIds) {
      await db.insert(arenaMembers).values({ arenaId: arena!.id, userId, visibility: "public" });
    }
    return arena!;
  }

  /** Write a daily score directly, so tests control the inputs exactly. */
  async function setDay(userId: string, day: Date, points: number) {
    await db
      .insert(dailyScores)
      .values({
        userId,
        day: startOfUtcDay(day),
        volumePts: points,
        efficiencyMultBp: 10_000,
        streakMultBp: 10_000,
        points,
      })
      .onConflictDoUpdate({
        target: [dailyScores.userId, dailyScores.day],
        set: { points },
      });
  }

  describe("recomputeStandings", () => {
    it("ranks members by season points and assigns titles", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      await setDay(a.id, NOW, 100);
      await setDay(b.id, NOW, 300);
      await setDay(c.id, NOW, 200);

      const result = await recomputeStandings(db, arena.id, season, NOW);

      expect(result.rows.map((r) => [r.handle, r.points, r.title])).toEqual([
        [b.handle, 300, "sovereign"],
        [c.handle, 200, "usurper"],
        [a.handle, 100, "contender"],
      ]);
    });

    it("replays decay in day order rather than summing — `#4.3`", async () => {
      // Two users, identical daily scores, different distribution. A `SUM()`
      // would tie them; decay must not.
      const [steady, bursty] = [await newUser(), await newUser()];
      const arena = await newArena([steady.id, bursty.id]);

      // The season has to *start in the past* for there to be elapsed days to
      // decay over — `seasonDays` deliberately refuses to score the future.
      const season = await ensureCurrentSeason(db, arena.id, addDays(NOW, -10));
      const day0 = startOfUtcDay(season.startsAt);

      // Steady: 100 on each of the first three days.
      for (let i = 0; i < 3; i++) await setDay(steady.id, addDays(day0, i), 100);
      // Bursty: all 300 on day one, then nothing — seven idle days to decay.
      await setDay(bursty.id, day0, 300);

      const result = await recomputeStandings(db, arena.id, season, NOW);
      const points = new Map(result.rows.map((r) => [r.handle, r.points]));

      expect(points.get(steady.handle)!).toBeGreaterThan(points.get(bursty.handle)!);
      // Gross totals are identical; only the decay path differs.
      expect(points.get(bursty.handle)!).toBeLessThan(300);
    });

    it("opens a reign and emits `crowned` for the first leader", async () => {
      const a = await newUser();
      const b = await newUser();
      const c = await newUser();
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);
      await setDay(a.id, NOW, 500);

      const result = await recomputeStandings(db, arena.id, season, NOW);

      expect(result.usurped).toEqual({ actorId: a.id, targetId: null });

      const [reign] = await db.select().from(reigns).where(eq(reigns.arenaId, arena.id));
      expect(reign).toMatchObject({ userId: a.id, endedAt: null, peakPoints: 500 });

      const [event] = await db.select().from(events).where(eq(events.arenaId, arena.id));
      // Nobody was dethroned, so it is not a usurping.
      expect(event).toMatchObject({ type: "crowned", actorId: a.id, targetId: null });
    });

    it("closes the old reign and emits `usurped` when #1 changes", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      await setDay(a.id, NOW, 500);
      await recomputeStandings(db, arena.id, season, NOW);

      // b overtakes.
      await setDay(b.id, NOW, 900);
      const later = new Date(NOW.getTime() + 60_000);
      const result = await recomputeStandings(db, arena.id, season, later);

      expect(result.usurped).toEqual({ actorId: b.id, targetId: a.id });

      const history = await db
        .select()
        .from(reigns)
        .where(eq(reigns.arenaId, arena.id))
        .orderBy(desc(reigns.startedAt));

      // `#6.2` — append-only: the old reign is closed, not rewritten away.
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({ userId: b.id, endedAt: null });
      expect(history[1]).toMatchObject({ userId: a.id, endedByUserId: b.id });
      expect(history[1]!.endedAt).not.toBeNull();

      const feed = await db
        .select()
        .from(events)
        .where(eq(events.arenaId, arena.id))
        .orderBy(desc(events.createdAt));
      expect(feed.map((e) => e.type)).toContain("usurped");
    });

    it("does not churn the reign when the same member stays on top", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      await setDay(a.id, NOW, 500);
      await recomputeStandings(db, arena.id, season, NOW);
      await recomputeStandings(db, arena.id, season, NOW);
      await recomputeStandings(db, arena.id, season, NOW);

      const history = await db.select().from(reigns).where(eq(reigns.arenaId, arena.id));
      expect(history).toHaveLength(1);

      // `#5` warns that a board which pings all day gets muted.
      const feed = await db.select().from(events).where(eq(events.arenaId, arena.id));
      expect(feed).toHaveLength(1);
    });

    it("tracks the peak for the Longest Reign board", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      await setDay(a.id, NOW, 500);
      await recomputeStandings(db, arena.id, season, NOW);
      await setDay(a.id, addDays(NOW, 1), 300);
      await recomputeStandings(db, arena.id, season, addDays(NOW, 1));

      const [reign] = await db.select().from(reigns).where(eq(reigns.arenaId, arena.id));
      expect(reign!.peakPoints).toBeGreaterThanOrEqual(500);
    });

    it("crowns nobody when every member has zero points", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      const result = await recomputeStandings(db, arena.id, season, NOW);

      // An empty arena has no sovereign — a throne has to be won.
      expect(result.usurped).toBeUndefined();
      expect(await db.select().from(reigns).where(eq(reigns.arenaId, arena.id))).toEqual([]);
    });

    it("serializes concurrent recomputes so only one reign opens — `#6.1`", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);
      await setDay(a.id, NOW, 500);

      // "Two members syncing simultaneously will otherwise race and can
      // produce two open reigns."
      await Promise.all([
        recomputeStandings(db, arena.id, season, NOW),
        recomputeStandings(db, arena.id, season, NOW),
        recomputeStandings(db, arena.id, season, NOW),
      ]);

      const open = await db
        .select()
        .from(reigns)
        .where(and(eq(reigns.arenaId, arena.id)));
      expect(open).toHaveLength(1);
    });

    it("records prevRank so the UI can show movement", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      await setDay(a.id, NOW, 500);
      await setDay(b.id, NOW, 100);
      await recomputeStandings(db, arena.id, season, NOW);

      await setDay(b.id, NOW, 900);
      await recomputeStandings(db, arena.id, season, NOW);

      const rows = await seasonStandings(db, season.id);
      const bRow = rows.find((r) => r.userId === b.id)!;
      expect(bRow.rank).toBe(1);
      expect(bRow.prevRank).toBe(2);
    });

    it("excludes members who left", async () => {
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);
      await setDay(a.id, NOW, 500);

      await db
        .update(arenaMembers)
        .set({ status: "left" })
        .where(and(eq(arenaMembers.arenaId, arena.id), eq(arenaMembers.userId, a.id)));

      const result = await recomputeStandings(db, arena.id, season, NOW);
      expect(result.rows.map((r) => r.userId)).not.toContain(a.id);
    });
  });

  describe("ratingBoard", () => {
    it("applies `#2` visibility: hidden absent, anonymous pseudonymous", async () => {
      const [named, anon, hidden] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([named.id, anon.id, hidden.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      await setDay(named.id, NOW, 300);
      await setDay(anon.id, NOW, 200);
      await setDay(hidden.id, NOW, 100);
      await recomputeStandings(db, arena.id, season, NOW);

      await setVisibility(db, anon.id, arena.id, "anonymous");
      await setVisibility(db, hidden.id, arena.id, "hidden");

      const board = await ratingBoard(db, arena.slug, { now: NOW });

      expect(board!.rows).toHaveLength(2);
      expect(board!.rows.find((r) => r.userId === hidden.id)).toBeUndefined();

      const anonRow = board!.rows.find((r) => r.userId === anon.id)!;
      expect(anonRow.handle).toBeNull();
      expect(anonRow.pseudonym).toMatch(/^Anonymous /);
      // `#2` — at their *true* rank, just unnamed.
      expect(anonRow.rank).toBe(2);
    });

    it("counts active members separately from visible rows", async () => {
      // The distinction that decides invite-prompt vs board. An arena where
      // everyone else is hidden renders one row but is NOT a solo arena, and
      // telling its member to "invite people" would leak that others exist —
      // exactly what `hidden` promises it will not do.
      const [a, b, c] = [await newUser(), await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id, c.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);
      await setDay(a.id, NOW, 300);
      await recomputeStandings(db, arena.id, season, NOW);

      await setVisibility(db, b.id, arena.id, "hidden");
      await setVisibility(db, c.id, arena.id, "hidden");

      const board = await ratingBoard(db, arena.slug, { now: NOW });
      expect(board!.memberCount).toBe(3);
      expect(board!.total).toBe(1);
    });

    it("counts a member who has never scored", async () => {
      // No `standings` row yet, so the join misses them — a fresh club must
      // not look solo just because nobody has synced.
      const [a, b] = [await newUser(), await newUser()];
      const arena = await newArena([a.id, b.id]);

      const board = await ratingBoard(db, arena.slug, { now: NOW });
      expect(board!.memberCount).toBe(2);
      expect(board!.total).toBe(0);
    });

    it("reports one member for a solo arena", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);
      const board = await ratingBoard(db, arena.slug, { now: NOW });
      expect(board!.memberCount).toBe(1);
    });

    it("reveals the invite code to the owner only", async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const [arena] = await db
        .insert(arenas)
        .values({
          type: "club",
          name: "Owned Club",
          slug: `oc-${Math.random().toString(36).slice(2, 10)}`,
          inviteCode: "OWNERONLY1",
          ownerUserId: owner.id,
          maxMembers: 50,
        })
        .returning();
      createdArenas.push(arena!.id);
      await db.insert(arenaMembers).values({ arenaId: arena!.id, userId: owner.id });

      const asOwner = await ratingBoard(db, arena!.slug, { now: NOW, viewerId: owner.id });
      const asStranger = await ratingBoard(db, arena!.slug, { now: NOW, viewerId: stranger.id });
      const anonymousViewer = await ratingBoard(db, arena!.slug, { now: NOW });

      expect(asOwner!.inviteCode).toBe("OWNERONLY1");
      // Any member could otherwise invite anyone; the owner controls entry.
      expect(asStranger!.inviteCode).toBeNull();
      expect(anonymousViewer!.inviteCode).toBeNull();
    });

    it("returns undefined for an unknown arena", async () => {
      expect(await ratingBoard(db, "no-such-arena", { now: NOW })).toBeUndefined();
    });
  });

  describe("seasons", () => {
    it("is idempotent and returns the same season", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);

      const first = await ensureCurrentSeason(db, arena.id, NOW);
      const second = await ensureCurrentSeason(db, arena.id, NOW);
      expect(second.id).toBe(first.id);
      expect(first.idx).toBe(1);
    });

    it("starts the next season where the last ended, leaving no gap", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);

      const first = await ensureCurrentSeason(db, arena.id, NOW);
      // A day after the first season closes.
      const later = addDays(first.endsAt, 1);
      const second = await ensureCurrentSeason(db, arena.id, later);

      expect(second.idx).toBe(2);
      // No hole in which activity would score into nothing.
      expect(second.startsAt.getTime()).toBe(first.endsAt.getTime());
    });

    it("spans four weeks", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      const days =
        (season.endsAt.getTime() - season.startsAt.getTime()) / 86_400_000;
      expect(days).toBe(SEASON_LENGTH_DAYS);
    });

    it("does not enumerate days in the future", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);
      const season = await ensureCurrentSeason(db, arena.id, NOW);

      const days = seasonDays(season, NOW);
      expect(days.at(-1)!.getTime()).toBeLessThanOrEqual(startOfUtcDay(NOW).getTime());
    });
  });
});
