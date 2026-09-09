/**
 * Shrinking circles — `SPEC.md#5.2`.
 *
 * > In arenas with ≥8 active members, a 4-week season runs in circles: wk1
 * > everyone → wk2 bottom 25% eliminated from *title contention* → wk3 bottom
 * > 25% again → wk4 final four contest the Reign. Eliminated members stay
 * > visible and keep accruing Burn stats, greyed as "out." Everything resets
 * > next season. Arenas <8 members run seasons without elimination.
 *
 * Three things the spec is precise about, and this file is built around:
 *
 *   1. Elimination is from **title contention**, not from the arena. An
 *      eliminated member keeps their rating position, keeps accruing, and stays
 *      on the board. They just cannot hold the Throne.
 *   2. The **8-member floor**. A four-person arena eliminating 25% twice would
 *      end with a "final four" of two, which is not a battle royale, it is a
 *      falling-out.
 *   3. **Everything resets next season.** Elimination lives on `standings`,
 *      which is per-season, never on `arena_members`.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { arenaMembers, seasons, standings, users } from "./schema.js";
import { addDays, startOfUtcDay, type Season } from "./seasons.js";

/** `#5.2` — below this, seasons run without elimination. */
export const MIN_MEMBERS_FOR_CIRCLES = 8;

/** `#5.2` — the fraction cut at the first two boundaries. */
export const CUT_FRACTION = 0.25;

/** `#5.2` — "wk4 final four contest the Reign". */
export const FINAL_CIRCLE_SIZE = 4;

export interface CircleCut {
  /** 1-indexed: cut 1 opens week 2. */
  index: number;
  /** When this cut becomes due. */
  at: Date;
  /**
   * How the cut is sized.
   *
   * `fraction` trims the bottom share; `keep` trims down to an absolute
   * survivor count, which is how "final four" is expressed.
   */
  kind: "fraction" | "keep";
  value: number;
}

export interface CircleSchedule {
  /** False when the arena was too small at season start. */
  enabled: boolean;
  /** Members counted when the schedule was fixed. */
  memberCountAtStart: number;
  cuts: CircleCut[];
}

/**
 * Build the schedule for a season.
 *
 * Fixed **once**, at season start, from the member count at that moment. If it
 * were recomputed live, someone joining mid-season could switch elimination on
 * — retroactively putting members at risk of a cut they never signed up to —
 * and someone leaving could switch it off and un-eliminate people.
 */
export function circleScheduleFor(season: Season, memberCount: number): CircleSchedule {
  if (memberCount < MIN_MEMBERS_FOR_CIRCLES) {
    return { enabled: false, memberCountAtStart: memberCount, cuts: [] };
  }

  const start = startOfUtcDay(season.startsAt);

  return {
    enabled: true,
    memberCountAtStart: memberCount,
    cuts: [
      // wk1 everyone; the first cut lands as week 2 opens.
      { index: 1, at: addDays(start, 7), kind: "fraction", value: CUT_FRACTION },
      { index: 2, at: addDays(start, 14), kind: "fraction", value: CUT_FRACTION },
      // wk4: down to the final four.
      { index: 3, at: addDays(start, 21), kind: "keep", value: FINAL_CIRCLE_SIZE },
    ],
  };
}

/** Read a stored schedule, tolerating a season written before circles existed. */
export function readSchedule(season: Season): CircleSchedule | undefined {
  const raw = season.circleSchedule as Partial<CircleSchedule> | undefined;
  if (!raw || typeof raw.enabled !== "boolean" || !Array.isArray(raw.cuts)) {
    return undefined;
  }
  return {
    enabled: raw.enabled,
    memberCountAtStart: Number(raw.memberCountAtStart ?? 0),
    cuts: raw.cuts.map((c) => ({
      index: Number(c.index),
      // JSON round-trips dates as strings.
      at: new Date(c.at as unknown as string),
      kind: c.kind === "keep" ? "keep" : "fraction",
      value: Number(c.value),
    })),
  };
}

/** Store a freshly built schedule on the season row. */
export async function attachSchedule(
  db: Db,
  season: Season,
  memberCount: number,
): Promise<CircleSchedule> {
  const schedule = circleScheduleFor(season, memberCount);
  await db
    .update(seasons)
    .set({ circleSchedule: schedule as unknown as Record<string, unknown> })
    .where(eq(seasons.id, season.id));
  return schedule;
}

/** How many survivors a cut leaves, given how many are still in contention. */
export function survivorsAfter(cut: CircleCut, inContention: number): number {
  if (cut.kind === "keep") return Math.min(inContention, cut.value);

  // Round the *cut* up, so "bottom 25%" of 6 removes 2 rather than 1 — a
  // circle that fails to shrink is not a circle.
  const removed = Math.ceil(inContention * cut.value);
  // Never cut below the final circle size; the last cut is what gets there.
  return Math.max(FINAL_CIRCLE_SIZE, inContention - removed);
}

export interface CircleResult {
  /** Cuts whose time had come and were applied. */
  applied: number[];
  /** Members eliminated by this run. */
  eliminated: Array<{ userId: string; handle: string; rank: number }>;
  /** Still in title contention afterwards. */
  inContention: number;
  /** Why nothing happened, when nothing happened. */
  skipped?: "disabled" | "not_due" | "too_few";
}

/**
 * Apply any due cuts for a season.
 *
 * Idempotent: eliminating is a one-way transition on `standings.status`, and a
 * cut whose survivors are already correct removes nobody. Safe to run on every
 * recompute, which is how it is wired — a season boundary should not need its
 * own precisely-timed job.
 *
 * Eliminates the *lowest-ranked members still in contention*, which is why it
 * must run after `recomputeStandings` has written current ranks.
 */
export async function applyCircles(
  db: Db,
  arenaId: string,
  season: Season,
  now = new Date(),
): Promise<CircleResult> {
  const schedule = readSchedule(season);

  if (!schedule || !schedule.enabled) {
    return { applied: [], eliminated: [], inContention: 0, skipped: "disabled" };
  }

  const due = schedule.cuts
    .filter((cut) => cut.at.getTime() <= now.getTime())
    .sort((a, b) => a.index - b.index);

  if (due.length === 0) {
    return { applied: [], eliminated: [], inContention: 0, skipped: "not_due" };
  }

  // Everyone still in contention, worst first — the cut comes off the bottom.
  const contenders = await db
    .select({
      userId: standings.userId,
      handle: users.handle,
      rank: standings.rank,
      points: standings.points,
    })
    .from(standings)
    .innerJoin(users, eq(users.id, standings.userId))
    .where(and(eq(standings.seasonId, season.id), eq(standings.status, "active")))
    .orderBy(asc(standings.rank));

  if (contenders.length <= FINAL_CIRCLE_SIZE) {
    return {
      applied: [],
      eliminated: [],
      inContention: contenders.length,
      skipped: "too_few",
    };
  }

  /**
   * Fold every due cut into one target survivor count.
   *
   * Folded from `memberCountAtStart`, **not** from the current contention
   * count. Deriving it from the current count makes the function
   * non-idempotent: after cut 1 takes 12 down to 9, a second run with cut 1
   * still due would compute `survivorsAfter(cut1, 9) = 6` and eat three more.
   * Since this runs on every recompute — every ten minutes — that would
   * empty the arena over an afternoon.
   *
   * Anchoring on the season-start count makes the target a pure function of
   * the schedule and the clock, so any number of runs at the same boundary
   * converge on the same field.
   */
  let target = schedule.memberCountAtStart;
  const applied: number[] = [];
  for (const cut of due) {
    target = survivorsAfter(cut, target);
    applied.push(cut.index);
  }

  if (target >= contenders.length) {
    return {
      applied: [],
      eliminated: [],
      inContention: contenders.length,
      skipped: "not_due",
    };
  }

  const doomed = contenders.slice(target);

  for (const member of doomed) {
    await db
      .update(standings)
      .set({ status: "eliminated" })
      .where(
        and(eq(standings.seasonId, season.id), eq(standings.userId, member.userId)),
      );
  }

  return {
    applied,
    eliminated: doomed.map((m) => ({
      userId: m.userId,
      handle: m.handle,
      rank: m.rank ?? 0,
    })),
    inContention: target,
  };
}

/** Active members of an arena, for sizing a schedule. */
export async function activeMemberCount(db: Db, arenaId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(arenaMembers)
    .where(and(eq(arenaMembers.arenaId, arenaId), sql`${arenaMembers.status} <> 'left'`));
  return Number(row?.n ?? 0);
}
