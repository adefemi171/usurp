/**
 * Seasons — `SPEC.md#5.2`.
 *
 * M2 needs the season *container* because `standings` is keyed on it. The
 * shrinking-circle mechanics that make a season interesting (`#5.2`'s
 * elimination schedule) are M3; this file deliberately creates a plain 4-week
 * window and nothing else.
 */

import { and, desc, eq, lte, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { seasons, type Arena } from "./schema.js";

/** `#5.2` — "a 4-week season runs in circles". */
export const SEASON_LENGTH_DAYS = 28;

export type Season = typeof seasons.$inferSelect;

/** Midnight UTC on the given day. Season boundaries are UTC, like buckets. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * Find or create the season containing `now` for an arena.
 *
 * Seasons are contiguous and non-overlapping: each starts where the previous
 * ended, so there is never a gap in which activity would score into nothing.
 * The first season for an arena starts at the current UTC day rather than at
 * the arena's creation date — backdating one would open a season already
 * partly elapsed, and `#4.3`'s decay would punish members for days before they
 * could have played.
 */
export async function ensureCurrentSeason(
  db: Db,
  arenaId: string,
  now = new Date(),
): Promise<Season> {
  const [current] = await db
    .select()
    .from(seasons)
    .where(
      and(
        eq(seasons.arenaId, arenaId),
        lte(seasons.startsAt, now),
        gte(seasons.endsAt, now),
      ),
    )
    .limit(1);

  if (current) return current;

  const [latest] = await db
    .select()
    .from(seasons)
    .where(eq(seasons.arenaId, arenaId))
    .orderBy(desc(seasons.idx))
    .limit(1);

  // Continue from the previous season's end so the timeline has no holes;
  // otherwise start today.
  const startsAt = latest ? latest.endsAt : startOfUtcDay(now);
  const idx = latest ? latest.idx + 1 : 1;

  const [created] = await db
    .insert(seasons)
    .values({
      arenaId,
      idx,
      startsAt,
      endsAt: addDays(startsAt, SEASON_LENGTH_DAYS),
      state: "active",
      circleSchedule: {},
    })
    // Two concurrent recomputes can both miss the season and both try to
    // create it; the unique (arena_id, idx) index arbitrates.
    .onConflictDoNothing()
    .returning();

  if (created) {
    // `#5.2`'s schedule is fixed once, from the member count at season start.
    // Recomputing it live would let a joiner switch elimination on for members
    // who never signed up to it, and a leaver switch it off again.
    const { activeMemberCount, attachSchedule } = await import("./circles.js");
    const members = await activeMemberCount(db, arenaId);
    const schedule = await attachSchedule(db, created, members);
    return { ...created, circleSchedule: schedule as unknown as Record<string, unknown> };
  }

  // Lost the race — re-read whatever the winner inserted.
  const [existing] = await db
    .select()
    .from(seasons)
    .where(and(eq(seasons.arenaId, arenaId), eq(seasons.idx, idx)))
    .limit(1);

  if (existing) return existing;
  throw new Error(`could not create or find season ${idx} for arena ${arenaId}`);
}

/** Every UTC day in a season, clipped to `now` so the future is not scored. */
export function seasonDays(season: Season, now = new Date()): Date[] {
  const days: Date[] = [];
  const end = season.endsAt < now ? season.endsAt : now;

  for (
    let day = startOfUtcDay(season.startsAt);
    day <= end;
    day = addDays(day, 1)
  ) {
    days.push(day);
  }
  return days;
}

/** Close seasons whose window has passed. Wired to a pg-boss job in M3. */
export async function closeElapsedSeasons(db: Db, now = new Date()): Promise<number> {
  const closed = await db
    .update(seasons)
    .set({ state: "closed" })
    .where(and(sql`${seasons.endsAt} < ${now}`, eq(seasons.state, "active")))
    .returning({ id: seasons.id });
  return closed.length;
}

/** The arenas that need a season, i.e. all of them. */
export async function ensureSeasonsForArenas(
  db: Db,
  arenas: readonly Pick<Arena, "id">[],
  now = new Date(),
): Promise<Map<string, Season>> {
  const out = new Map<string, Season>();
  for (const arena of arenas) {
    out.set(arena.id, await ensureCurrentSeason(db, arena.id, now));
  }
  return out;
}
