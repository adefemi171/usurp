/**
 * Duels — `SPEC.md#5.3`.
 *
 * > Challenge a named member over a fixed window (24h / 7d) on a chosen
 * > metric, wagering rating points. Winner takes the pot. This is Fancysauce's
 * > "challenge a teammate" with actual stakes.
 *
 * And from `#5`: "duels capped at 2 concurrent per user".
 *
 * ── Where the wagered points live ───────────────────────────────────────────
 * Not in `standings.points`. That column is *derived* — the recompute replays
 * it from `daily_scores` every ten minutes — so a wager written there would be
 * silently erased at the next run. Settlement writes `standings.duel_pts`
 * instead, which the recompute preserves and adds in. One column owned by the
 * scheduler, one by settlement, and `points` is their sum.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  arenaMembers,
  dailyScores,
  duels,
  events,
  standings,
  usageEvents,
  users,
} from "./schema.js";
import { ensureCurrentSeason, startOfUtcDay } from "./seasons.js";

/** `#5` — "duels capped at 2 concurrent per user". */
export const MAX_CONCURRENT_DUELS = 2;

/** `#5.3` — "a fixed window (24h / 7d)". */
export const DUEL_WINDOWS = { "24h": 24, "7d": 168 } as const;
export type DuelWindow = keyof typeof DUEL_WINDOWS;

/** How long a challenge waits before it lapses. */
export const PROPOSAL_TTL_HOURS = 48;

export const MIN_WAGER = 1;
export const MAX_WAGER = 1000;

/**
 * `#5.3` — "a chosen metric".
 *
 * Rating points is the headline; the other two exist because a duel on raw
 * output is a different (and more legible) bet than one on rating. Note there
 * is deliberately **no token metric**: `#4.1` says ranking on volume rewards
 * waste, and a duel on tokens burned would be a race to waste the most.
 */
export const DUEL_METRICS = ["points", "commits", "edits"] as const;
export type DuelMetric = (typeof DUEL_METRICS)[number];

export type Duel = typeof duels.$inferSelect;

export type ProposeFailure =
  | "not_a_member"
  | "opponent_not_a_member"
  | "self_duel"
  | "too_many_duels"
  | "opponent_too_many_duels"
  | "already_duelling"
  | "invalid_wager"
  | "insufficient_points";

export type ProposeResult =
  | { ok: true; duel: Duel }
  | { ok: false; failure: ProposeFailure };

/** Concurrent duels are the proposed and accepted ones — settled do not count. */
async function concurrentCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(duels)
    .where(
      and(
        or(eq(duels.challengerId, userId), eq(duels.opponentId, userId)),
        inArray(duels.state, ["proposed", "accepted"]),
      ),
    );
  return Number(row?.n ?? 0);
}

/** A member's current season points in an arena, for affordability checks. */
async function seasonPoints(db: Db, arenaId: string, userId: string, now: Date): Promise<number> {
  const season = await ensureCurrentSeason(db, arenaId, now);
  const [row] = await db
    .select({ points: standings.points })
    .from(standings)
    .where(and(eq(standings.seasonId, season.id), eq(standings.userId, userId)))
    .limit(1);
  return Number(row?.points ?? 0);
}

export interface ProposeInput {
  arenaId: string;
  challengerId: string;
  opponentId: string;
  metric: DuelMetric;
  wagerPts: number;
  window: DuelWindow;
  now?: Date;
}

export async function proposeDuel(db: Db, input: ProposeInput): Promise<ProposeResult> {
  const now = input.now ?? new Date();

  if (input.challengerId === input.opponentId) {
    return { ok: false, failure: "self_duel" };
  }
  if (
    !Number.isInteger(input.wagerPts) ||
    input.wagerPts < MIN_WAGER ||
    input.wagerPts > MAX_WAGER
  ) {
    return { ok: false, failure: "invalid_wager" };
  }

  return db.transaction(async (tx) => {
    const members = await tx
      .select({ userId: arenaMembers.userId })
      .from(arenaMembers)
      .where(
        and(
          eq(arenaMembers.arenaId, input.arenaId),
          inArray(arenaMembers.userId, [input.challengerId, input.opponentId]),
          sql`${arenaMembers.status} <> 'left'`,
        ),
      );

    const ids = new Set(members.map((m) => m.userId));
    if (!ids.has(input.challengerId)) {
      return { ok: false as const, failure: "not_a_member" as const };
    }
    if (!ids.has(input.opponentId)) {
      return { ok: false as const, failure: "opponent_not_a_member" as const };
    }

    // `#5` — the cap applies to both sides. Enforcing it only on the
    // challenger would let one person paralyse a rival by filling their slots.
    if ((await concurrentCount(tx as unknown as Db, input.challengerId)) >= MAX_CONCURRENT_DUELS) {
      return { ok: false as const, failure: "too_many_duels" as const };
    }
    if ((await concurrentCount(tx as unknown as Db, input.opponentId)) >= MAX_CONCURRENT_DUELS) {
      return { ok: false as const, failure: "opponent_too_many_duels" as const };
    }

    // One live duel per pair per arena, or a grudge becomes a spam channel.
    const [existing] = await tx
      .select({ id: duels.id })
      .from(duels)
      .where(
        and(
          eq(duels.arenaId, input.arenaId),
          inArray(duels.state, ["proposed", "accepted"]),
          or(
            and(
              eq(duels.challengerId, input.challengerId),
              eq(duels.opponentId, input.opponentId),
            ),
            and(
              eq(duels.challengerId, input.opponentId),
              eq(duels.opponentId, input.challengerId),
            ),
          ),
        ),
      )
      .limit(1);

    if (existing) return { ok: false as const, failure: "already_duelling" as const };

    // Both sides must be able to cover the wager, or "winner takes the pot"
    // means a winner collecting from an empty pocket.
    const challengerPoints = await seasonPoints(
      tx as unknown as Db,
      input.arenaId,
      input.challengerId,
      now,
    );
    if (challengerPoints < input.wagerPts) {
      return { ok: false as const, failure: "insufficient_points" as const };
    }

    // The window opens on acceptance, not on proposal — otherwise a slow
    // reply silently eats the challenged party's time.
    const [duel] = await tx
      .insert(duels)
      .values({
        arenaId: input.arenaId,
        challengerId: input.challengerId,
        opponentId: input.opponentId,
        metric: input.metric,
        wagerPts: input.wagerPts,
        windowStart: now,
        windowEnd: new Date(now.getTime() + PROPOSAL_TTL_HOURS * 3_600_000),
        state: "proposed",
      })
      .returning();

    await tx.insert(events).values({
      arenaId: input.arenaId,
      type: EVENT_DUEL_PROPOSED,
      actorId: input.challengerId,
      targetId: input.opponentId,
      payload: {
        duelId: duel!.id,
        metric: input.metric,
        wagerPts: input.wagerPts,
        window: input.window,
      },
      createdAt: now,
    });

    return { ok: true as const, duel: duel! };
  });
}

export const EVENT_DUEL_PROPOSED = "duel_proposed";
export const EVENT_DUEL_ACCEPTED = "duel_accepted";
export const EVENT_DUEL_DECLINED = "duel_declined";
export const EVENT_DUEL_SETTLED = "duel_settled";

export type RespondFailure = "not_found" | "not_yours" | "not_pending" | "expired";

export type RespondResult =
  | { ok: true; duel: Duel }
  | { ok: false; failure: RespondFailure };

/**
 * Accept a challenge, which starts the clock.
 *
 * `window` is chosen by the challenger at proposal time and applied here, so
 * the contested window is exactly the agreed length however long the reply took.
 */
export async function acceptDuel(
  db: Db,
  userId: string,
  duelId: string,
  options: { window?: DuelWindow; now?: Date } = {},
): Promise<RespondResult> {
  const now = options.now ?? new Date();

  return db.transaction(async (tx) => {
    const [duel] = await tx
      .select()
      .from(duels)
      .where(eq(duels.id, duelId))
      .limit(1)
      .for("update");

    if (!duel) return { ok: false as const, failure: "not_found" as const };
    // Only the challenged party can accept.
    if (duel.opponentId !== userId) return { ok: false as const, failure: "not_yours" as const };
    if (duel.state !== "proposed") return { ok: false as const, failure: "not_pending" as const };

    if (duel.windowEnd.getTime() <= now.getTime()) {
      await tx.update(duels).set({ state: "expired" }).where(eq(duels.id, duel.id));
      return { ok: false as const, failure: "expired" as const };
    }

    const hours = DUEL_WINDOWS[options.window ?? "24h"];

    const [accepted] = await tx
      .update(duels)
      .set({
        state: "accepted",
        windowStart: now,
        windowEnd: new Date(now.getTime() + hours * 3_600_000),
      })
      .where(eq(duels.id, duel.id))
      .returning();

    await tx.insert(events).values({
      arenaId: duel.arenaId,
      type: EVENT_DUEL_ACCEPTED,
      actorId: userId,
      targetId: duel.challengerId,
      payload: { duelId: duel.id, metric: duel.metric, wagerPts: duel.wagerPts },
      createdAt: now,
    });

    return { ok: true as const, duel: accepted! };
  });
}

export async function declineDuel(
  db: Db,
  userId: string,
  duelId: string,
  options: { now?: Date } = {},
): Promise<RespondResult> {
  const now = options.now ?? new Date();

  return db.transaction(async (tx) => {
    const [duel] = await tx
      .select()
      .from(duels)
      .where(eq(duels.id, duelId))
      .limit(1)
      .for("update");

    if (!duel) return { ok: false as const, failure: "not_found" as const };
    // Either party may back out while it is still only a proposal — the
    // challenger by withdrawing, the opponent by declining.
    if (duel.opponentId !== userId && duel.challengerId !== userId) {
      return { ok: false as const, failure: "not_yours" as const };
    }
    if (duel.state !== "proposed") return { ok: false as const, failure: "not_pending" as const };

    const [declined] = await tx
      .update(duels)
      .set({ state: "declined" })
      .where(eq(duels.id, duel.id))
      .returning();

    await tx.insert(events).values({
      arenaId: duel.arenaId,
      type: EVENT_DUEL_DECLINED,
      actorId: userId,
      targetId: userId === duel.opponentId ? duel.challengerId : duel.opponentId,
      payload: { duelId: duel.id },
      createdAt: now,
    });

    return { ok: true as const, duel: declined! };
  });
}

/** What each side scored on the contested metric, within the window. */
export async function duelScores(
  db: Db,
  duel: Duel,
): Promise<{ challenger: number; opponent: number }> {
  const ids = [duel.challengerId, duel.opponentId];

  if (duel.metric === "points") {
    // Daily granularity, so the window is snapped to whole UTC days — the
    // same unit `daily_scores` is keyed on. A sub-day duel on a daily metric
    // would otherwise credit a whole day to a one-hour window.
    const rows = await db
      .select({ userId: dailyScores.userId, points: dailyScores.points })
      .from(dailyScores)
      .where(
        and(
          inArray(dailyScores.userId, ids),
          gte(dailyScores.day, startOfUtcDay(duel.windowStart)),
          lte(dailyScores.day, startOfUtcDay(duel.windowEnd)),
        ),
      );

    const total = (id: string) =>
      rows.filter((r) => r.userId === id).reduce((a, r) => a + r.points, 0);
    return { challenger: total(duel.challengerId), opponent: total(duel.opponentId) };
  }

  const column = duel.metric === "commits" ? usageEvents.commits : usageEvents.editsApplied;

  const rows = await db
    .select({
      userId: usageEvents.userId,
      total: sql<string>`coalesce(sum(${column}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(
        inArray(usageEvents.userId, ids),
        eq(usageEvents.historical, false),
        gte(usageEvents.hour, duel.windowStart),
        lt(usageEvents.hour, duel.windowEnd),
      ),
    )
    .groupBy(usageEvents.userId);

  const total = (id: string) => Number(rows.find((r) => r.userId === id)?.total ?? 0);
  return { challenger: total(duel.challengerId), opponent: total(duel.opponentId) };
}

export interface SettledDuel {
  duelId: string;
  arenaId: string;
  winnerId: string | null;
  challengerScore: number;
  opponentScore: number;
  wagerPts: number;
  draw: boolean;
}

/**
 * Settle every accepted duel whose window has closed, and lapse stale
 * proposals.
 *
 * `#5.3` — "Winner takes the pot": the winner gains the wager and the loser
 * loses it, so the arena's total rating is unchanged. A draw returns both
 * stakes rather than splitting them; splitting a pot on a tie would mean a
 * drawn duel still moved the board.
 */
export async function settleDuels(
  db: Db,
  options: { now?: Date } = {},
): Promise<SettledDuel[]> {
  const now = options.now ?? new Date();

  // Proposals nobody answered lapse quietly — no points move, no event, since
  // `#5` warns that a board which pings all day gets muted.
  await db
    .update(duels)
    .set({ state: "expired" })
    .where(and(eq(duels.state, "proposed"), lt(duels.windowEnd, now)));

  const due = await db
    .select()
    .from(duels)
    .where(and(eq(duels.state, "accepted"), lt(duels.windowEnd, now)));

  const settled: SettledDuel[] = [];

  for (const duel of due) {
    const scores = await duelScores(db, duel);
    const draw = scores.challenger === scores.opponent;
    const winnerId = draw
      ? null
      : scores.challenger > scores.opponent
        ? duel.challengerId
        : duel.opponentId;
    const loserId = draw
      ? null
      : winnerId === duel.challengerId
        ? duel.opponentId
        : duel.challengerId;

    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(duels)
        .set({ state: "settled", winnerId })
        // Guarded on the state we read, so two concurrent settlement passes
        // cannot both pay out the same pot.
        .where(and(eq(duels.id, duel.id), eq(duels.state, "accepted")))
        .returning({ id: duels.id });

      if (!claimed) return;

      if (winnerId && loserId) {
        const season = await ensureCurrentSeason(tx as unknown as Db, duel.arenaId, now);

        // `duel_pts` is the durable half; `points` is refreshed by the next
        // recompute, and updating it here keeps the board correct until then.
        for (const [userId, delta] of [
          [winnerId, duel.wagerPts],
          [loserId, -duel.wagerPts],
        ] as const) {
          await tx
            .update(standings)
            .set({
              duelPts: sql`${standings.duelPts} + ${delta}`,
              points: sql`greatest(0, ${standings.points} + ${delta})`,
              updatedAt: now,
            })
            .where(and(eq(standings.seasonId, season.id), eq(standings.userId, userId)));
        }
      }

      await tx.insert(events).values({
        arenaId: duel.arenaId,
        type: EVENT_DUEL_SETTLED,
        actorId: winnerId ?? duel.challengerId,
        targetId: winnerId ? (loserId ?? null) : duel.opponentId,
        payload: {
          duelId: duel.id,
          metric: duel.metric,
          wagerPts: duel.wagerPts,
          draw,
          challengerScore: scores.challenger,
          opponentScore: scores.opponent,
        },
        createdAt: now,
      });

      settled.push({
        duelId: duel.id,
        arenaId: duel.arenaId,
        winnerId,
        challengerScore: scores.challenger,
        opponentScore: scores.opponent,
        wagerPts: duel.wagerPts,
        draw,
      });
    });
  }

  return settled;
}

export interface DuelView {
  id: string;
  arenaId: string;
  metric: string;
  wagerPts: number;
  state: string;
  windowStart: Date;
  windowEnd: Date;
  /** The other party, from the caller's point of view. */
  opponent: { userId: string; handle: string };
  /** True when the caller issued the challenge. */
  isChallenger: boolean;
  winnerId: string | null;
}

/** Every duel a user is party to, newest first. */
export async function duelsForUser(db: Db, userId: string): Promise<DuelView[]> {
  const rows = await db
    .select({
      duel: duels,
      challengerHandle: sql<string>`(select handle from ${users} u where u.id = ${duels.challengerId})`,
      opponentHandle: sql<string>`(select handle from ${users} u where u.id = ${duels.opponentId})`,
    })
    .from(duels)
    .where(or(eq(duels.challengerId, userId), eq(duels.opponentId, userId)))
    .orderBy(sql`${duels.windowStart} desc`);

  return rows.map(({ duel, challengerHandle, opponentHandle }) => {
    const isChallenger = duel.challengerId === userId;
    return {
      id: duel.id,
      arenaId: duel.arenaId,
      metric: duel.metric,
      wagerPts: duel.wagerPts,
      state: duel.state,
      windowStart: duel.windowStart,
      windowEnd: duel.windowEnd,
      opponent: {
        userId: isChallenger ? duel.opponentId : duel.challengerId,
        handle: isChallenger ? opponentHandle : challengerHandle,
      },
      isChallenger,
      winnerId: duel.winnerId,
    };
  });
}
