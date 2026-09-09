/**
 * Shrinking circles — `SPEC.md#5.2`.
 *
 * The arithmetic is unit-tested; the state transitions need a database,
 * because the property that matters is that elimination is **one-way within a
 * season** and survives a recompute running every ten minutes.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import { arenaMembers, arenas, dailyScores, seasons, standings, users } from "./schema.js";
import {
  CUT_FRACTION,
  FINAL_CIRCLE_SIZE,
  MIN_MEMBERS_FOR_CIRCLES,
  applyCircles,
  attachSchedule,
  circleScheduleFor,
  readSchedule,
  survivorsAfter,
} from "./circles.js";
import { recomputeStandings, seasonStandings } from "./rating.js";
import { addDays, ensureCurrentSeason, startOfUtcDay, type Season } from "./seasons.js";
import { signInWithOAuth } from "./auth.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const SEASON_START = new Date("2026-09-01T00:00:00.000Z");

function fakeSeason(overrides: Partial<Season> = {}): Season {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    arenaId: "00000000-0000-0000-0000-000000000001",
    idx: 1,
    startsAt: SEASON_START,
    endsAt: addDays(SEASON_START, 28),
    circleSchedule: {},
    state: "active",
    ...overrides,
  } as Season;
}

describe("circleScheduleFor", () => {
  it("is disabled below the 8-member floor — `#5.2`", () => {
    for (const n of [0, 1, 4, 7]) {
      const schedule = circleScheduleFor(fakeSeason(), n);
      expect(schedule.enabled, `${n} members`).toBe(false);
      expect(schedule.cuts).toEqual([]);
    }
  });

  it("enables at exactly 8", () => {
    const schedule = circleScheduleFor(fakeSeason(), MIN_MEMBERS_FOR_CIRCLES);
    expect(schedule.enabled).toBe(true);
    expect(schedule.cuts).toHaveLength(3);
  });

  it("puts the cuts at the week boundaries: wk2, wk3, wk4", () => {
    const schedule = circleScheduleFor(fakeSeason(), 20);
    const days = schedule.cuts.map(
      (c) => (c.at.getTime() - startOfUtcDay(SEASON_START).getTime()) / 86_400_000,
    );
    // "wk1 everyone" — the first cut lands as week 2 opens.
    expect(days).toEqual([7, 14, 21]);
  });

  it("makes the last cut the final four", () => {
    const schedule = circleScheduleFor(fakeSeason(), 20);
    expect(schedule.cuts.at(-1)).toMatchObject({ kind: "keep", value: FINAL_CIRCLE_SIZE });
  });

  it("round-trips through JSON", () => {
    const schedule = circleScheduleFor(fakeSeason(), 12);
    const season = fakeSeason({
      circleSchedule: JSON.parse(JSON.stringify(schedule)) as Record<string, unknown>,
    });
    const read = readSchedule(season)!;

    expect(read.enabled).toBe(true);
    // Dates survive as Dates, not strings.
    expect(read.cuts[0]!.at).toBeInstanceOf(Date);
    expect(read.cuts[0]!.at.getTime()).toBe(schedule.cuts[0]!.at.getTime());
  });

  it("returns undefined for a season written before circles existed", () => {
    expect(readSchedule(fakeSeason({ circleSchedule: {} }))).toBeUndefined();
  });
});

describe("survivorsAfter", () => {
  it("rounds the cut up, so a circle always shrinks", () => {
    // 25% of 6 is 1.5. Rounding the cut down would remove 1 and leave 5,
    // which is a circle that failed to close.
    expect(survivorsAfter({ index: 1, at: new Date(), kind: "fraction", value: CUT_FRACTION }, 6)).toBe(4);
  });

  it("cuts a quarter of a large field", () => {
    const cut = { index: 1, at: new Date(), kind: "fraction" as const, value: CUT_FRACTION };
    expect(survivorsAfter(cut, 20)).toBe(15);
    expect(survivorsAfter(cut, 8)).toBe(6);
  });

  it("never cuts below the final circle size", () => {
    const cut = { index: 1, at: new Date(), kind: "fraction" as const, value: CUT_FRACTION };
    expect(survivorsAfter(cut, 5)).toBe(FINAL_CIRCLE_SIZE);
    expect(survivorsAfter(cut, 4)).toBe(FINAL_CIRCLE_SIZE);
  });

  it("keeps an absolute count for the final cut", () => {
    const cut = { index: 3, at: new Date(), kind: "keep" as const, value: FINAL_CIRCLE_SIZE };
    expect(survivorsAfter(cut, 15)).toBe(4);
    // Never grows the circle.
    expect(survivorsAfter(cut, 3)).toBe(3);
  });

  it("walks 8 members down to the final four", () => {
    const fraction = { index: 1, at: new Date(), kind: "fraction" as const, value: CUT_FRACTION };
    const keep = { index: 3, at: new Date(), kind: "keep" as const, value: FINAL_CIRCLE_SIZE };

    const afterWk2 = survivorsAfter(fraction, 8);
    const afterWk3 = survivorsAfter(fraction, afterWk2);
    const afterWk4 = survivorsAfter(keep, afterWk3);

    expect([afterWk2, afterWk3, afterWk4]).toEqual([6, 4, 4]);
  });
});

describe.skipIf(!hasDb)("circles (database)", () => {
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

  async function newUser() {
    const { user } = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: `cr_${Math.random().toString(36).slice(2, 12)}`,
      username: `cr${Math.random().toString(36).slice(2, 10)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  /** An arena of `size` members, each scored so ranks are deterministic. */
  async function arenaWith(size: number) {
    const members = [];
    for (let i = 0; i < size; i++) members.push(await newUser());

    const [arena] = await db
      .insert(arenas)
      .values({
        type: "club",
        name: "Circle Test",
        slug: `cr-${Math.random().toString(36).slice(2, 10)}`,
        maxMembers: 50,
      })
      .returning();
    createdArenas.push(arena!.id);

    for (const m of members) {
      await db.insert(arenaMembers).values({ arenaId: arena!.id, userId: m.id });
    }

    // Season starts in the past so cut boundaries can be reached.
    const season = await ensureCurrentSeason(db, arena!.id, SEASON_START);
    await attachSchedule(db, season, size);
    const withSchedule = (
      await db.select().from(seasons).where(eq(seasons.id, season.id))
    )[0]!;

    // Descending points, so member[0] is rank 1 and member[n-1] is last.
    for (const [i, m] of members.entries()) {
      await db.insert(dailyScores).values({
        userId: m.id,
        day: startOfUtcDay(SEASON_START),
        volumePts: 0,
        efficiencyMultBp: 10_000,
        streakMultBp: 10_000,
        points: (size - i) * 100,
      });
    }

    return { arena: arena!, season: withSchedule, members };
  }

  const atDay = (n: number) => addDays(SEASON_START, n);

  describe("applyCircles", () => {
    it("does nothing before the first boundary", async () => {
      const { arena, season } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(3));

      const result = await applyCircles(db, arena.id, season, atDay(3));
      expect(result.skipped).toBe("not_due");
      expect(result.eliminated).toEqual([]);
    });

    it("cuts the bottom 25% as week 2 opens", async () => {
      const { arena, season, members } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(7));

      const result = await applyCircles(db, arena.id, season, atDay(7));

      // 12 -> 9
      expect(result.inContention).toBe(9);
      expect(result.eliminated).toHaveLength(3);
      // The cut comes off the bottom: the last three by points.
      const eliminatedIds = result.eliminated.map((e) => e.userId);
      expect(eliminatedIds).toEqual(members.slice(9).map((m) => m.id));
    });

    it("is a no-op when re-run for the same boundary", async () => {
      const { arena, season } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(7));

      const first = await applyCircles(db, arena.id, season, atDay(7));
      const second = await applyCircles(db, arena.id, season, atDay(7));

      // Runs every ten minutes; it must not keep eating the field.
      expect(first.eliminated).toHaveLength(3);
      expect(second.eliminated).toEqual([]);
    });

    it("folds missed boundaries, so a late first run lands in the same place", async () => {
      const { arena, season } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(21));

      // Never ran during weeks 2 and 3; all three cuts are due at once.
      const result = await applyCircles(db, arena.id, season, atDay(21));

      expect(result.applied).toEqual([1, 2, 3]);
      expect(result.inContention).toBe(FINAL_CIRCLE_SIZE);
    });

    it("reaches the final four by week 4", async () => {
      const { arena, season } = await arenaWith(12);

      for (const day of [7, 14, 21]) {
        await recomputeStandings(db, arena.id, season, atDay(day));
        await applyCircles(db, arena.id, season, atDay(day));
      }

      const rows = await seasonStandings(db, season.id);
      expect(rows.filter((r) => !r.eliminated)).toHaveLength(FINAL_CIRCLE_SIZE);
    });

    it("does nothing in an arena below the member floor", async () => {
      const { arena, season } = await arenaWith(5);
      await recomputeStandings(db, arena.id, season, atDay(21));

      const result = await applyCircles(db, arena.id, season, atDay(21));
      // `#5.2` — "Arenas <8 members run seasons without elimination."
      expect(result.skipped).toBe("disabled");
      expect(result.eliminated).toEqual([]);
    });
  });

  describe("elimination and the board", () => {
    it("keeps eliminated members listed, without a title", async () => {
      const { arena, season } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(7));
      await applyCircles(db, arena.id, season, atDay(7));
      await recomputeStandings(db, arena.id, season, atDay(8));

      const rows = await seasonStandings(db, season.id);

      // `#5.2` — "Eliminated members stay visible and keep accruing."
      expect(rows).toHaveLength(12);
      const out = rows.filter((r) => r.eliminated);
      expect(out).toHaveLength(3);
      for (const row of out) expect(row.title).toBeUndefined();
    });

    it("survives a recompute — elimination is one-way within a season", async () => {
      const { arena, season } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(7));
      await applyCircles(db, arena.id, season, atDay(7));

      // The recompute runs every ten minutes; it must not resurrect anyone.
      for (let i = 0; i < 3; i++) {
        await recomputeStandings(db, arena.id, season, atDay(8));
      }

      const rows = await seasonStandings(db, season.id);
      expect(rows.filter((r) => r.eliminated)).toHaveLength(3);
    });

    it("assigns titles by contention position, not overall rank", async () => {
      const { arena, season, members } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(7));
      await applyCircles(db, arena.id, season, atDay(7));

      // Eliminate the current leader by hand, so contention order differs
      // from points order.
      await db
        .update(standings)
        .set({ status: "eliminated" })
        .where(
          and(eq(standings.seasonId, season.id), eq(standings.userId, members[0]!.id)),
        );

      const rows = await seasonStandings(db, season.id);

      // Rank 1 by points is out, so the Sovereign is the next contender.
      expect(rows[0]!.eliminated).toBe(true);
      expect(rows[0]!.title).toBeUndefined();
      expect(rows[1]!.title).toBe("sovereign");
      expect(rows[2]!.title).toBe("usurper");
    });

    it("does not crown an eliminated member", async () => {
      const { arena, season, members } = await arenaWith(12);
      await recomputeStandings(db, arena.id, season, atDay(7));

      // Take the points leader out of contention.
      await db
        .update(standings)
        .set({ status: "eliminated" })
        .where(
          and(eq(standings.seasonId, season.id), eq(standings.userId, members[0]!.id)),
        );

      const result = await recomputeStandings(db, arena.id, season, atDay(8));

      // The Throne goes to the top *contender*.
      expect(result.usurped?.actorId).toBe(members[1]!.id);
    });
  });

  describe("season schedule", () => {
    it("is attached at creation from the member count then", async () => {
      const { season } = await arenaWith(9);
      const schedule = readSchedule(season)!;

      expect(schedule.enabled).toBe(true);
      expect(schedule.memberCountAtStart).toBe(9);
    });

    it("does not change when members join later", async () => {
      const { arena, season } = await arenaWith(5);
      expect(readSchedule(season)!.enabled).toBe(false);

      // Five more join, crossing the floor.
      for (let i = 0; i < 5; i++) {
        const u = await newUser();
        await db.insert(arenaMembers).values({ arenaId: arena.id, userId: u.id });
      }

      // The schedule is fixed: nobody is retroactively put at risk of a cut
      // they could not have known about.
      const [reread] = await db.select().from(seasons).where(eq(seasons.id, season.id));
      expect(readSchedule(reread!)!.enabled).toBe(false);
    });
  });
});
