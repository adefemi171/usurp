/**
 * Duels — `SPEC.md#5.3`.
 *
 * The tests that matter most are the ones about *points not leaking*: a wager
 * that survives a recompute, a pot that pays out exactly once, and a draw that
 * moves nothing.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import { arenaMembers, arenas, dailyScores, devices, duels, standings, usageEvents, users } from "./schema.js";
import {
  MAX_CONCURRENT_DUELS,
  acceptDuel,
  declineDuel,
  duelScores,
  duelsForUser,
  proposeDuel,
  settleDuels,
} from "./duels.js";
import { recomputeStandings } from "./rating.js";
import { addDays, ensureCurrentSeason, startOfUtcDay } from "./seasons.js";
import { signInWithOAuth } from "./auth.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-09-20T12:00:00.000Z");

describe.skipIf(!hasDb)("duels (database)", () => {
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
      providerUid: `dl_${Math.random().toString(36).slice(2, 12)}`,
      username: `dl${Math.random().toString(36).slice(2, 10)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  /** An arena whose members already have season points to wager. */
  async function arena(points = 500, size = 3) {
    const members = [];
    for (let i = 0; i < size; i++) members.push(await newUser());

    const [row] = await db
      .insert(arenas)
      .values({
        type: "club",
        name: "Duel Test",
        slug: `dl-${Math.random().toString(36).slice(2, 10)}`,
        maxMembers: 50,
      })
      .returning();
    createdArenas.push(row!.id);

    for (const m of members) {
      await db.insert(arenaMembers).values({ arenaId: row!.id, userId: m.id });
      await db.insert(dailyScores).values({
        userId: m.id,
        day: startOfUtcDay(NOW),
        volumePts: points,
        efficiencyMultBp: 10_000,
        streakMultBp: 10_000,
        points,
      });
    }

    const season = await ensureCurrentSeason(db, row!.id, NOW);
    await recomputeStandings(db, row!.id, season, NOW);

    return { arena: row!, season, members };
  }

  const pointsOf = async (seasonId: string, userId: string) => {
    const [row] = await db
      .select({ points: standings.points, duelPts: standings.duelPts })
      .from(standings)
      .where(and(eq(standings.seasonId, seasonId), eq(standings.userId, userId)));
    return row!;
  };

  describe("proposeDuel", () => {
    it("creates a proposal and emits an event", async () => {
      const { arena: a, members } = await arena();
      const result = await proposeDuel(db, {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "points",
        wagerPts: 50,
        window: "24h",
        now: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.duel).toMatchObject({ state: "proposed", wagerPts: 50, metric: "points" });
      }
    });

    it("refuses a self-duel", async () => {
      const { arena: a, members } = await arena();
      expect(
        await proposeDuel(db, {
          arenaId: a.id,
          challengerId: members[0]!.id,
          opponentId: members[0]!.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        }),
      ).toEqual({ ok: false, failure: "self_duel" });
    });

    it("refuses a non-member on either side", async () => {
      const { arena: a, members } = await arena();
      const stranger = await newUser();

      expect(
        (await proposeDuel(db, {
          arenaId: a.id,
          challengerId: stranger.id,
          opponentId: members[0]!.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        })) as { failure: string },
      ).toMatchObject({ failure: "not_a_member" });

      expect(
        (await proposeDuel(db, {
          arenaId: a.id,
          challengerId: members[0]!.id,
          opponentId: stranger.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        })) as { failure: string },
      ).toMatchObject({ failure: "opponent_not_a_member" });
    });

    it("rejects a wager outside the bounds", async () => {
      const { arena: a, members } = await arena();
      for (const wagerPts of [0, -5, 1001, 1.5]) {
        expect(
          (await proposeDuel(db, {
            arenaId: a.id,
            challengerId: members[0]!.id,
            opponentId: members[1]!.id,
            metric: "points",
            wagerPts,
            window: "24h",
            now: NOW,
          })) as { failure: string },
        ).toMatchObject({ failure: "invalid_wager" });
      }
    });

    it("refuses a wager the challenger cannot cover", async () => {
      // "Winner takes the pot" needs there to be a pot.
      const { arena: a, members } = await arena(20);
      expect(
        (await proposeDuel(db, {
          arenaId: a.id,
          challengerId: members[0]!.id,
          opponentId: members[1]!.id,
          metric: "points",
          wagerPts: 500,
          window: "24h",
          now: NOW,
        })) as { failure: string },
      ).toMatchObject({ failure: "insufficient_points" });
    });

    it("caps concurrent duels at 2 per user — `#5`", async () => {
      const { arena: a, members } = await arena(500, 5);
      const [me, b, c, d] = members;

      for (const other of [b!, c!]) {
        const r = await proposeDuel(db, {
          arenaId: a.id,
          challengerId: me!.id,
          opponentId: other.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        });
        expect(r.ok).toBe(true);
      }

      expect(
        (await proposeDuel(db, {
          arenaId: a.id,
          challengerId: me!.id,
          opponentId: d!.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        })) as { failure: string },
      ).toMatchObject({ failure: "too_many_duels" });
    });

    it("applies the cap to the opponent too", async () => {
      // Otherwise one person could paralyse a rival by filling their slots.
      const { arena: a, members } = await arena(500, 5);
      const [target, x, y, z] = members;

      for (const challenger of [x!, y!]) {
        await proposeDuel(db, {
          arenaId: a.id,
          challengerId: challenger.id,
          opponentId: target!.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        });
      }

      expect(
        (await proposeDuel(db, {
          arenaId: a.id,
          challengerId: z!.id,
          opponentId: target!.id,
          metric: "points",
          wagerPts: 10,
          window: "24h",
          now: NOW,
        })) as { failure: string },
      ).toMatchObject({ failure: "opponent_too_many_duels" });
    });

    it("refuses a second live duel between the same pair", async () => {
      const { arena: a, members } = await arena();
      const input = {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "points" as const,
        wagerPts: 10,
        window: "24h" as const,
        now: NOW,
      };
      await proposeDuel(db, input);

      // A grudge should not become a spam channel — and the reverse
      // direction counts as the same pair.
      expect(
        (await proposeDuel(db, {
          ...input,
          challengerId: members[1]!.id,
          opponentId: members[0]!.id,
        })) as { failure: string },
      ).toMatchObject({ failure: "already_duelling" });
    });
  });

  describe("accept / decline", () => {
    async function proposal() {
      const { arena: a, season, members } = await arena();
      const result = await proposeDuel(db, {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "points",
        wagerPts: 50,
        window: "24h",
        now: NOW,
      });
      if (!result.ok) throw new Error(result.failure);
      return { arena: a, season, members, duel: result.duel };
    }

    it("starts the clock on acceptance, not on proposal", async () => {
      const { members, duel } = await proposal();
      const later = new Date(NOW.getTime() + 6 * 3_600_000);

      const accepted = await acceptDuel(db, members[1]!.id, duel.id, {
        window: "24h",
        now: later,
      });

      expect(accepted.ok).toBe(true);
      if (accepted.ok) {
        // A slow reply must not eat the contested window.
        expect(accepted.duel.windowStart.getTime()).toBe(later.getTime());
        expect(accepted.duel.windowEnd.getTime()).toBe(later.getTime() + 24 * 3_600_000);
      }
    });

    it("honours the 7d window", async () => {
      const { members, duel } = await proposal();
      const accepted = await acceptDuel(db, members[1]!.id, duel.id, {
        window: "7d",
        now: NOW,
      });
      if (!accepted.ok) throw new Error(accepted.failure);
      expect(
        (accepted.duel.windowEnd.getTime() - accepted.duel.windowStart.getTime()) / 3_600_000,
      ).toBe(168);
    });

    it("lets only the challenged party accept", async () => {
      const { members, duel } = await proposal();
      // The challenger accepting their own challenge would be a free wager.
      expect(await acceptDuel(db, members[0]!.id, duel.id, { now: NOW })).toEqual({
        ok: false,
        failure: "not_yours",
      });
      expect(await acceptDuel(db, members[2]!.id, duel.id, { now: NOW })).toEqual({
        ok: false,
        failure: "not_yours",
      });
    });

    it("cannot be accepted twice", async () => {
      const { members, duel } = await proposal();
      await acceptDuel(db, members[1]!.id, duel.id, { now: NOW });
      expect(await acceptDuel(db, members[1]!.id, duel.id, { now: NOW })).toEqual({
        ok: false,
        failure: "not_pending",
      });
    });

    it("expires a proposal past its TTL, and says so", async () => {
      const { members, duel } = await proposal();
      const tooLate = new Date(NOW.getTime() + 72 * 3_600_000);

      expect(await acceptDuel(db, members[1]!.id, duel.id, { now: tooLate })).toEqual({
        ok: false,
        failure: "expired",
      });

      const [row] = await db.select().from(duels).where(eq(duels.id, duel.id));
      expect(row!.state).toBe("expired");
    });

    it("lets either party back out of a proposal", async () => {
      const first = await proposal();
      expect((await declineDuel(db, first.members[1]!.id, first.duel.id, { now: NOW })).ok).toBe(true);

      const second = await proposal();
      // The challenger withdrawing is the same transition.
      expect((await declineDuel(db, second.members[0]!.id, second.duel.id, { now: NOW })).ok).toBe(true);
    });

    it("refuses a decline from an uninvolved member", async () => {
      const { members, duel } = await proposal();
      expect(await declineDuel(db, members[2]!.id, duel.id, { now: NOW })).toEqual({
        ok: false,
        failure: "not_yours",
      });
    });
  });

  describe("settlement", () => {
    /** An accepted duel whose window has closed, with the given day scores. */
    async function closedDuel(
      challengerPoints: number,
      opponentPoints: number,
      wagerPts = 50,
    ) {
      const { arena: a, season, members } = await arena(500);
      const proposed = await proposeDuel(db, {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "points",
        wagerPts,
        window: "24h",
        now: NOW,
      });
      if (!proposed.ok) throw new Error(proposed.failure);
      await acceptDuel(db, members[1]!.id, proposed.duel.id, { window: "24h", now: NOW });

      // Contested day sits inside the window.
      const day = addDays(startOfUtcDay(NOW), 0);
      for (const [member, pts] of [
        [members[0]!, challengerPoints],
        [members[1]!, opponentPoints],
      ] as const) {
        await db
          .insert(dailyScores)
          .values({
            userId: member.id,
            day,
            volumePts: pts,
            efficiencyMultBp: 10_000,
            streakMultBp: 10_000,
            points: pts,
          })
          .onConflictDoUpdate({
            target: [dailyScores.userId, dailyScores.day],
            set: { points: pts },
          });
      }

      return { arena: a, season, members, duel: proposed.duel };
    }

    const after = new Date(NOW.getTime() + 25 * 3_600_000);

    it("pays the winner and charges the loser", async () => {
      const { season, members, duel } = await closedDuel(900, 100, 50);

      const settled = await settleDuels(db, { now: after });
      const mine = settled.find((s) => s.duelId === duel.id)!;

      expect(mine.winnerId).toBe(members[0]!.id);
      expect(mine.draw).toBe(false);

      const winner = await pointsOf(season.id, members[0]!.id);
      const loser = await pointsOf(season.id, members[1]!.id);

      // The pot moves; the arena's total rating is unchanged.
      expect(winner.duelPts).toBe(50);
      expect(loser.duelPts).toBe(-50);
    });

    it("returns both stakes on a draw", async () => {
      const { season, members, duel } = await closedDuel(400, 400, 50);

      const settled = await settleDuels(db, { now: after });
      expect(settled.find((s) => s.duelId === duel.id)!.draw).toBe(true);

      // Splitting a pot on a tie would mean a drawn duel still moved the board.
      for (const m of [members[0]!, members[1]!]) {
        expect((await pointsOf(season.id, m.id)).duelPts).toBe(0);
      }
    });

    it("pays out exactly once, however often settlement runs", async () => {
      const { season, members, duel } = await closedDuel(900, 100, 50);

      await settleDuels(db, { now: after });
      await settleDuels(db, { now: after });
      await settleDuels(db, { now: after });

      expect((await pointsOf(season.id, members[0]!.id)).duelPts).toBe(50);

      const [row] = await db.select().from(duels).where(eq(duels.id, duel.id));
      expect(row!.state).toBe("settled");
    });

    it("does not settle a duel whose window is still open", async () => {
      const { duel } = await closedDuel(900, 100);
      const settled = await settleDuels(db, { now: NOW });
      expect(settled.find((s) => s.duelId === duel.id)).toBeUndefined();
    });

    it("survives a recompute — the wager is not erased", async () => {
      // The reason `duel_pts` is its own column: `points` is replayed from
      // `daily_scores` every ten minutes.
      const { arena: a, season, members } = await closedDuel(900, 100, 50);
      await settleDuels(db, { now: after });

      const before = await pointsOf(season.id, members[0]!.id);
      await recomputeStandings(db, a.id, season, after);
      const afterRecompute = await pointsOf(season.id, members[0]!.id);

      expect(afterRecompute.duelPts).toBe(50);
      expect(afterRecompute.points).toBeGreaterThanOrEqual(before.duelPts);
    });

    it("lapses an unanswered proposal without moving points", async () => {
      const { arena: a, season, members } = await arena();
      const proposed = await proposeDuel(db, {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "points",
        wagerPts: 50,
        window: "24h",
        now: NOW,
      });
      if (!proposed.ok) throw new Error(proposed.failure);

      await settleDuels(db, { now: new Date(NOW.getTime() + 72 * 3_600_000) });

      const [row] = await db.select().from(duels).where(eq(duels.id, proposed.duel.id));
      expect(row!.state).toBe("expired");
      expect((await pointsOf(season.id, members[0]!.id)).duelPts).toBe(0);
      void a;
    });

    it("never drives a member's points negative", async () => {
      // Wager the loser's entire stake, which the affordability guard allows.
      // They should land on exactly 0, not below it — `duel_pts` goes to -500
      // while `points` is clamped, so the ledger stays honest either way.
      const { season, members } = await closedDuel(900, 100, 500);
      await settleDuels(db, { now: after });

      const loser = await pointsOf(season.id, members[1]!.id);
      expect(loser.points).toBeGreaterThanOrEqual(0);
      expect(loser.duelPts).toBe(-500);
    });
  });

  describe("duelScores", () => {
    it.each(["commits", "edits"] as const)("excludes archive imports from %s duels", async (metric) => {
      const { arena: a, members } = await arena();
      const proposed = await proposeDuel(db, {
        arenaId: a.id, challengerId: members[0]!.id, opponentId: members[1]!.id,
        metric, wagerPts: 10, window: "24h", now: NOW,
      });
      if (!proposed.ok) throw new Error(proposed.failure);
      const accepted = await acceptDuel(db, members[1]!.id, proposed.duel.id, { window: "24h", now: NOW });
      if (!accepted.ok) throw new Error(accepted.failure);
      const deviceId = `archive_${members[0]!.id}`;
      await db.insert(devices).values({ id: deviceId, userId: members[0]!.id, publicKey: deviceId });
      await db.insert(usageEvents).values([false, true].map(historical => ({
        deviceId, userId: members[0]!.id, agent: "test", model: "test", historical,
        hour: NOW, commits: historical ? 999 : 3, editsApplied: historical ? 999 : 7,
        dedupeKey: `${deviceId}_${historical}`, sigOk: true,
      })));
      expect(await duelScores(db, accepted.duel)).toEqual({ challenger: metric === "commits" ? 3 : 7, opponent: 0 });
    });

    it("counts commits inside the window only", async () => {
      const { arena: a, members } = await arena();
      const proposed = await proposeDuel(db, {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "commits",
        wagerPts: 10,
        window: "24h",
        now: NOW,
      });
      if (!proposed.ok) throw new Error(proposed.failure);
      const accepted = await acceptDuel(db, members[1]!.id, proposed.duel.id, {
        window: "24h",
        now: NOW,
      });
      if (!accepted.ok) throw new Error(accepted.failure);

      const scores = await duelScores(db, accepted.duel);
      // No usage in the window yet.
      expect(scores).toEqual({ challenger: 0, opponent: 0 });
    });
  });

  describe("duelsForUser", () => {
    it("reports the other party from the caller's point of view", async () => {
      const { arena: a, members } = await arena();
      await proposeDuel(db, {
        arenaId: a.id,
        challengerId: members[0]!.id,
        opponentId: members[1]!.id,
        metric: "points",
        wagerPts: 10,
        window: "24h",
        now: NOW,
      });

      const mine = await duelsForUser(db, members[0]!.id);
      const theirs = await duelsForUser(db, members[1]!.id);

      expect(mine[0]!.isChallenger).toBe(true);
      expect(mine[0]!.opponent.handle).toBe(members[1]!.handle);
      expect(theirs[0]!.isChallenger).toBe(false);
      expect(theirs[0]!.opponent.handle).toBe(members[0]!.handle);
    });
  });

  it("respects the documented cap constant", () => {
    expect(MAX_CONCURRENT_DUELS).toBe(2);
  });
});
