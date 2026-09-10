/**
 * The rating recompute path — `SPEC.md#6.1`.
 *
 *   usage_events  ──aggregate per user per UTC day──▶  daily_scores
 *   daily_scores  ──replay with #4.3 decay per arena──▶  standings
 *   standings     ──diff rank 1──▶  reigns + events
 *
 * ── RESOLVED CONTRADICTION: which cohort do z-scores use? ───────────────────
 * `#4.2` (line 121) says signals are "normalized to a z-score against the
 * user's own **arena cohort** (so a hobbyist isn't scored against a monorepo
 * team)". `#6` (line 36) says "scores are computed once, **globally**, per user
 * per day. Arenas are views over the same `daily_scores` — never per-arena
 * scoring logic."
 *
 * These cannot both hold: under `#4.2` a user in three arenas has three
 * different daily scores, and `daily_scores` is keyed `(user_id, day)`.
 *
 * Resolved in favour of `#6` — global cohort — for two reasons:
 *
 *   1. `#4.2`'s stated rationale is not achieved by cohort-relative
 *      efficiency. The hobbyist-vs-team gap lives in `volume_pts`, which is
 *      absolute (`10 × log10(...)`, no cohort term). Measured: a hobbyist day
 *      scores 25.2 volume points against a heavy team day's 45.1, and that
 *      19.9-point gap is identical whichever cohort you normalize against.
 *      Cohort-relative z only moves the [0.5, 2.0] multiplier.
 *   2. It is the only option the schema admits, and `#6` states it twice,
 *      including the explicit prohibition "never per-arena scoring logic".
 *
 * Recorded honestly: this is **not** a free choice. Simulated on a homogeneous
 * 12-person club inside a 500-player field, global and arena-local z agreed on
 * only 44.6% of within-club orderings (random would be ~8%). So the two
 * produce genuinely different boards, and `#6`'s consistency is bought at the
 * cost of discrimination inside small cohorts. If that turns out to matter in
 * practice, the fix is a per-arena rating table, not a tweak here.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  DEFAULT_WEIGHTS,
  dailyScore,
  isActive,
  rawSignals,
  zScores,
  type DailyMetrics,
  type Weights,
} from "@usurp/scoring";
import type { Db } from "./client.js";
import {
  arenaMembers,
  arenas,
  dailyScores,
  events,
  reigns,
  standings,
  usageEvents,
  users,
} from "./schema.js";
import {
  addDays,
  ensureCurrentSeason,
  seasonDays,
  startOfUtcDay,
  type Season,
} from "./seasons.js";
import { EVENT_CROWNED, EVENT_USURPED, titleForRank } from "./titles.js";
import { pseudonymFor } from "./board.js";
import { currentSovereign } from "./feed.js";

/**
 * How far back to read activity when computing a streak.
 *
 * `#4.2`'s streak multiplier caps at +25% after 9 consecutive days, so 14 days
 * of history is more than enough to know a streak's length for scoring
 * purposes without scanning a user's whole history.
 */
export const STREAK_LOOKBACK_DAYS = 14;

interface DayRow {
  userId: string;
  day: Date;
  metrics: DailyMetrics;
}

/**
 * Roll `usage_events` up to one `DailyMetrics` per user per UTC day.
 *
 * `AT TIME ZONE 'UTC'` rather than a bare `date_trunc`: `date_trunc` on a
 * timestamptz uses the session's TimeZone, so day boundaries would depend on
 * where the server runs and disagree with the UTC hours the buckets were built
 * on.
 */
export async function dailyMetrics(
  db: Db,
  from: Date,
  to: Date,
): Promise<DayRow[]> {
  const dayExpr = sql<string>`date_trunc('day', ${usageEvents.hour} AT TIME ZONE 'UTC')`;

  const rows = await db
    .select({
      userId: usageEvents.userId,
      day: dayExpr,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      calls: sql<string>`coalesce(sum(${usageEvents.calls}), 0)`,
      sessionsStarted: sql<string>`coalesce(sum(${usageEvents.sessionsStarted}), 0)`,
      sessionsCompleted: sql<string>`coalesce(sum(${usageEvents.sessionsCompleted}), 0)`,
      sessionsAbandoned: sql<string>`coalesce(sum(${usageEvents.sessionsAbandoned}), 0)`,
      editsApplied: sql<string>`coalesce(sum(${usageEvents.editsApplied}), 0)`,
      editsReverted: sql<string>`coalesce(sum(${usageEvents.editsReverted}), 0)`,
      commits: sql<string>`coalesce(sum(${usageEvents.commits}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.hour, from),
        lt(usageEvents.hour, to),
        eq(usageEvents.historical, false),
        eq(usageEvents.sigOk, true),
      ),
    )
    .groupBy(usageEvents.userId, dayExpr);

  const n = (v: unknown) => Number(v ?? 0);

  return rows.map((r) => ({
    userId: r.userId,
    // `date_trunc(... AT TIME ZONE 'UTC')` returns a naive timestamp; parse it
    // back as UTC rather than letting the driver apply a local offset.
    day: new Date(`${String(r.day).slice(0, 10)}T00:00:00Z`),
    metrics: {
      inputTokens: n(r.inputTokens),
      outputTokens: n(r.outputTokens),
      cacheWriteTokens: n(r.cacheWriteTokens),
      cacheReadTokens: n(r.cacheReadTokens),
      calls: n(r.calls),
      sessionsStarted: n(r.sessionsStarted),
      sessionsCompleted: n(r.sessionsCompleted),
      sessionsAbandoned: n(r.sessionsAbandoned),
      editsApplied: n(r.editsApplied),
      editsReverted: n(r.editsReverted),
      commits: n(r.commits),
    },
  }));
}

export interface RecomputeDailyResult {
  days: number;
  rows: number;
  users: number;
}

/**
 * Recompute `daily_scores` for every day in `[from, to)`.
 *
 * Whole days at a time, because z-scores are cohort-relative: one user's score
 * is not defined without everyone else's for that day. That is also why this
 * cannot be done incrementally per submission — a late bucket from one user
 * shifts the cohort mean and therefore every other user's score for that day.
 */
export async function recomputeDailyScores(
  db: Db,
  from: Date,
  to: Date,
  weights: Weights = DEFAULT_WEIGHTS,
): Promise<RecomputeDailyResult> {
  const start = startOfUtcDay(from);
  const end = startOfUtcDay(to);

  // Read a little further back than we write, so a streak that began before
  // the window is not mistaken for a fresh one.
  const readFrom = addDays(start, -STREAK_LOOKBACK_DAYS);
  const rows = await dailyMetrics(db, readFrom, end);

  const byDay = new Map<number, DayRow[]>();
  const activeDaysByUser = new Map<string, Set<number>>();

  for (const row of rows) {
    const key = row.day.getTime();
    const list = byDay.get(key) ?? [];
    list.push(row);
    byDay.set(key, list);

    if (isActive(row.metrics)) {
      const set = activeDaysByUser.get(row.userId) ?? new Set<number>();
      set.add(key);
      activeDaysByUser.set(row.userId, set);
    }
  }

  /** Consecutive active days ending on `day`, inclusive. */
  const streakFor = (userId: string, day: number): number => {
    const active = activeDaysByUser.get(userId);
    if (!active?.has(day)) return 0;

    let streak = 0;
    for (let d = day; active.has(d); d -= 86_400_000) {
      streak++;
      // Bounded by the lookback: past the streak cap it makes no difference.
      if (streak > STREAK_LOOKBACK_DAYS) break;
    }
    return streak;
  };

  let written = 0;
  const touchedUsers = new Set<string>();
  let daysWritten = 0;

  for (const [dayKey, cohort] of [...byDay.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    // Only persist the requested window; earlier days were read for streaks.
    if (dayKey < start.getTime()) continue;
    daysWritten++;

    const zs = zScores(cohort.map((c) => rawSignals(c.metrics)));

    for (const [i, row] of cohort.entries()) {
      const score = dailyScore(
        row.metrics,
        zs[i]!,
        streakFor(row.userId, dayKey),
        weights,
      );

      await db
        .insert(dailyScores)
        .values({
          userId: row.userId,
          day: new Date(dayKey),
          volumePts: Math.round(score.volumePts),
          // Multipliers are stored in basis points to keep the row integral
          // while staying auditable — a support question is usually "why is my
          // score low", and the three factors answer it.
          efficiencyMultBp: Math.round(score.efficiencyMult * 10_000),
          streakMultBp: Math.round(score.streakMult * 10_000),
          points: Math.round(score.points),
          computedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [dailyScores.userId, dailyScores.day],
          set: {
            volumePts: sql`excluded.volume_pts`,
            efficiencyMultBp: sql`excluded.efficiency_mult_bp`,
            streakMultBp: sql`excluded.streak_mult_bp`,
            points: sql`excluded.points`,
            computedAt: sql`excluded.computed_at`,
          },
        });

      written++;
      touchedUsers.add(row.userId);
    }
  }

  return { days: daysWritten, rows: written, users: touchedUsers.size };
}

export interface StandingRow {
  userId: string;
  handle: string;
  points: number;
  rank: number;
  prevRank: number | null;
  /** `#5.2` — out of title contention, still on the board. */
  eliminated: boolean;
  title: ReturnType<typeof titleForRank>;
}

export interface RecomputeStandingsResult {
  seasonId: string;
  members: number;
  /** Set when rank 1 changed hands. */
  usurped?: { actorId: string; targetId: string | null };
  rows: StandingRow[];
}

/**
 * A stable 64-bit advisory-lock key from an arena id — `#6.1`.
 *
 * "Take a per-arena Postgres advisory lock around the standings write. Two
 * members syncing simultaneously will otherwise race and can produce two open
 * reigns."
 */
export function arenaLockKey(arenaId: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(arenaId, "utf8")) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return BigInt.asIntN(64, hash);
}

/**
 * Recompute one arena's standings for a season, and reconcile the Throne.
 *
 * Season points are *replayed* day by day rather than summed, because `#4.3`'s
 * decay is path-dependent: 5% of the running total is lost per inactive day, so
 * the same set of daily scores in a different order yields a different total.
 * A `SUM()` would silently discard the mechanic that makes a throne
 * contestable.
 */
export async function recomputeStandings(
  db: Db,
  arenaId: string,
  season: Season,
  now = new Date(),
): Promise<RecomputeStandingsResult> {
  return db.transaction(async (tx) => {
    // `#6.1` — serialize per arena so two syncs cannot open two reigns.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${arenaLockKey(arenaId)})`,
    );

    const members = await tx
      .select({
        userId: arenaMembers.userId,
        handle: users.handle,
        reviewState: users.reviewState,
      })
      .from(arenaMembers)
      .innerJoin(users, eq(users.id, arenaMembers.userId))
      .where(
        and(
          eq(arenaMembers.arenaId, arenaId),
          sql`${arenaMembers.status} <> 'left'`,
        ),
      );

    if (members.length === 0) {
      return { seasonId: season.id, members: 0, rows: [] };
    }

    const days = seasonDays(season, now);
    const memberIds = members.map((m) => m.userId);

    const scores = await tx
      .select({
        userId: dailyScores.userId,
        day: dailyScores.day,
        points: dailyScores.points,
      })
      .from(dailyScores)
      .where(
        and(
          inArray(dailyScores.userId, memberIds),
          gte(dailyScores.day, startOfUtcDay(season.startsAt)),
          lt(dailyScores.day, season.endsAt),
        ),
      );

    const previous = await tx
      .select({
        userId: standings.userId,
        rank: standings.rank,
        status: standings.status,
        duelPts: standings.duelPts,
        points: standings.points,
      })
      .from(standings)
      .where(eq(standings.seasonId, season.id));
    const prevRankByUser = new Map(previous.map((p) => [p.userId, p.rank]));
    const previousPoints = new Map(previous.map((p) => [p.userId, p.points]));
    const frozen = new Set(
      members
        .filter((m) => m.reviewState === "shadow_frozen")
        .map((m) => m.userId),
    );
    // `#5.2` — elimination is a one-way transition within a season. A
    // recompute must never resurrect someone a circle already cut, or the
    // mechanic would undo itself every ten minutes.
    const statusByUser = new Map(previous.map((p) => [p.userId, p.status]));
    // `#5.3` — duel winnings are owned by settlement, not by this replay, so
    // they are read back and added in rather than recomputed. Writing `points`
    // without them would erase every wager at the next run.
    const duelPtsByUser = new Map(previous.map((p) => [p.userId, p.duelPts]));
    // Rank one at zero points is not an incumbent. Compare the actual open
    // reign, otherwise the first sync by the same rank-one user never crowns
    // them and every later recompute keeps updating a nonexistent reign.
    const [openReign] = await tx
      .select()
      .from(reigns)
      .where(and(eq(reigns.arenaId, arenaId), isNull(reigns.endedAt)))
      .limit(1);
    const previousLeader = openReign?.userId ?? null;

    const byUserDay = new Map<string, number>();
    for (const s of scores) {
      byUserDay.set(`${s.userId}|${startOfUtcDay(s.day).getTime()}`, s.points);
    }

    // Replay each member's season, so decay is applied in order.
    const totals = members.map((member) => {
      let points = 0;
      for (const day of days) {
        const dayPoints =
          byUserDay.get(`${member.userId}|${day.getTime()}`) ?? 0;
        if (dayPoints > 0) {
          points += dayPoints;
        } else {
          // `#4.3` — standing still is falling.
          points *= 0.95;
        }
      }
      // Season points are the replayed total plus any net duel result.
      const duelPts = duelPtsByUser.get(member.userId) ?? 0;
      return {
        ...member,
        points: frozen.has(member.userId)
          ? (previousPoints.get(member.userId) ?? 0)
          : Math.max(0, points + duelPts),
      };
    });

    // Ties break on handle so a page boundary is stable across requests.
    totals.sort(
      (a, b) => b.points - a.points || a.handle.localeCompare(b.handle),
    );

    // Titles are positional among members still in **title contention**
    // (`#5.2`), not among everyone: an eliminated member keeps their rating
    // position and stays on the board, but cannot be Sovereign.
    const eliminated = new Set(
      [...statusByUser.entries()]
        .filter(([, s]) => s === "eliminated")
        .map(([id]) => id),
    );

    let contentionSeen = 0;
    const contenders = totals.filter(
      (t) => !eliminated.has(t.userId) && !frozen.has(t.userId),
    ).length;

    const rows: StandingRow[] = totals.map((t, index) => {
      const isEliminated = eliminated.has(t.userId);
      const contentionRank =
        isEliminated || frozen.has(t.userId) ? null : ++contentionSeen;

      return {
        userId: t.userId,
        handle: t.handle,
        points: Math.round(t.points),
        rank: index + 1,
        prevRank: prevRankByUser.get(t.userId) ?? null,
        eliminated: isEliminated,
        title:
          contentionRank === null || Math.round(t.points) <= 0
            ? undefined
            : titleForRank(contentionRank, contenders),
      };
    });

    for (const row of rows) {
      await tx
        .insert(standings)
        .values({
          seasonId: season.id,
          userId: row.userId,
          points: row.points,
          rank: row.rank,
          prevRank: row.prevRank,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [standings.seasonId, standings.userId],
          set: {
            points: sql`excluded.points`,
            rank: sql`excluded.rank`,
            // Carry the rank we are replacing, so the UI can show movement.
            prevRank: sql`${standings.rank}`,
            updatedAt: sql`excluded.updated_at`,
            // `status` is deliberately absent: it is owned by `applyCircles`,
            // and writing it here would un-eliminate everyone on every run.
          },
        });
    }

    // The top member still in contention — an eliminated member cannot hold
    // the Throne even if their points are highest (`#5.2`).
    const leader = rows.find((r) => !r.eliminated && !frozen.has(r.userId));
    // Nobody with zero points holds a throne — an empty arena has no sovereign.
    const newLeaderId = leader && leader.points > 0 ? leader.userId : null;

    let usurped: RecomputeStandingsResult["usurped"];

    if (newLeaderId && newLeaderId !== previousLeader) {
      // `#6.2` — reigns are append-only. Close the old one, open a new one;
      // never rewrite either, even if late data would have prevented this.
      if (openReign) {
        await tx
          .update(reigns)
          .set({ endedAt: now, endedByUserId: newLeaderId })
          .where(eq(reigns.id, openReign.id));
      }

      await tx.insert(reigns).values({
        arenaId,
        userId: newLeaderId,
        startedAt: now,
        peakPoints: leader!.points,
      });

      const targetId = openReign?.userId ?? null;
      await tx.insert(events).values({
        arenaId,
        // `crowned` when there was no incumbent: nobody was dethroned.
        type: targetId ? EVENT_USURPED : EVENT_CROWNED,
        actorId: newLeaderId,
        targetId,
        payload: { points: leader!.points, seasonId: season.id },
        createdAt: now,
      });

      usurped = { actorId: newLeaderId, targetId };
    } else if (newLeaderId) {
      // Same holder — keep the peak honest for the Longest Reign board.
      await tx
        .update(reigns)
        .set({
          peakPoints: sql`greatest(${reigns.peakPoints}, ${leader!.points})`,
        })
        .where(and(eq(reigns.arenaId, arenaId), isNull(reigns.endedAt)));
    }

    // Delivered only after commit; listeners re-read through visibility checks.
    await tx.execute(sql`select pg_notify('usurp_board_changed', ${arenaId})`);
    return {
      seasonId: season.id,
      members: rows.length,
      ...(usurped ? { usurped } : {}),
      rows,
    };
  });
}

/** Read a season's standings for the rating board. */
export async function seasonStandings(
  db: Db,
  seasonId: string,
): Promise<StandingRow[]> {
  const rows = await db
    .select({
      userId: standings.userId,
      handle: users.handle,
      points: standings.points,
      rank: standings.rank,
      prevRank: standings.prevRank,
      status: standings.status,
      reviewState: users.reviewState,
    })
    .from(standings)
    .innerJoin(users, eq(users.id, standings.userId))
    .where(eq(standings.seasonId, seasonId))
    .orderBy(asc(standings.rank));

  const contenders = rows.filter(
    (r) => r.status !== "eliminated" && r.reviewState !== "shadow_frozen",
  ).length;
  let seen = 0;

  return rows.map((r) => {
    const isEliminated = r.status === "eliminated";
    const contentionRank =
      isEliminated || r.reviewState === "shadow_frozen" ? null : ++seen;
    return {
      userId: r.userId,
      handle: r.handle,
      points: r.points,
      rank: r.rank ?? 0,
      prevRank: r.prevRank,
      eliminated: isEliminated,
      title:
        contentionRank === null || r.points <= 0
          ? undefined
          : titleForRank(contentionRank, contenders),
    };
  });
}

export interface RatingBoard {
  arena: { slug: string; name: string; type: "global" | "org" | "club" };
  season: { idx: number; startsAt: Date; endsAt: Date };
  rows: Array<
    // `handle` is replaced, not extended: `#2` lets an anonymous member keep
    // their true rank without their name, so it must be nullable here even
    // though `StandingRow` (an internal, pre-visibility shape) guarantees it.
    Omit<StandingRow, "handle"> & {
      /** Null when the member competes anonymously — `#2`. */
      handle: string | null;
      displayName: string | null;
      /**
       * Null for an anonymous member. An avatar is as identifying as a name —
       * arguably more so, since it is usually the same image across sites — so
       * it is suppressed alongside the handle rather than left in.
       */
      avatarUrl: string | null;
      pseudonym: string | null;
      /** Rank movement since the last recompute. Positive = climbed. */
      movement: number | null;
      trustTier: "unverified" | "cli_signed" | "org_verified";
      underReview: boolean;
    }
  >;
  /** Visible rows, after `#2` visibility filtering. */
  total: number;
  /**
   * Active members regardless of visibility.
   *
   * Distinct from `total` on purpose. An arena with one member and an arena
   * where four of five members are `hidden` both render one row, but they need
   * opposite messages: the first wants an invite prompt, the second must not
   * be told to invite anyone — that would leak the fact that other members
   * exist, which is exactly what `hidden` promises it will not do.
   */
  memberCount: number;
  /** Populated only when the viewer owns the arena — it is the join secret. */
  inviteCode: string | null;
  /**
   * The open reign, if the Throne is held.
   *
   * `#5.1` tracks `reign_length_days` because that *is* the tension: a board
   * showing only who is first tells you nothing about whether they are
   * entrenched or just arrived. Null when nobody has won it yet.
   */
  throne: {
    userId: string;
    startedAt: Date;
    heldSeconds: number;
    /** Resolved under `#2` visibility, so an anonymous Sovereign stays so. */
    display: string | null;
  } | null;
}

/**
 * The rating board — `#4.1`'s actual league.
 *
 * Reads `standings` rather than recomputing (`#6`: "the board is the hottest
 * read path and must not recompute per request"), then applies `#2`'s
 * visibility rules on the way out. A `hidden` member is dropped entirely and an
 * `anonymous` one keeps their true rank under a stable pseudonym — the same
 * contract the Burn board honours.
 */
export async function ratingBoard(
  db: Db,
  slug: string,
  options: {
    limit?: number;
    offset?: number;
    now?: Date;
    viewerId?: string;
    trust?: "unverified" | "cli_signed" | "org_verified";
  } = {},
): Promise<RatingBoard | undefined> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const now = options.now ?? new Date();

  const [arena] = await db
    .select()
    .from(arenas)
    .where(eq(arenas.slug, slug))
    .limit(1);
  if (!arena) return undefined;

  // Independent reads must not incur consecutive remote database round trips.
  const [season, sovereign, [memberTally]] = await Promise.all([
    ensureCurrentSeason(db, arena.id, now),
    currentSovereign(db, arena.id),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(arenaMembers)
      .where(
        and(
          eq(arenaMembers.arenaId, arena.id),
          sql`${arenaMembers.status} <> 'left'`,
        ),
      ),
  ]);

  const rows = await db
    .select({
      userId: standings.userId,
      handle: users.handle,
      avatarUrl: users.avatarUrl,
      points: standings.points,
      rank: standings.rank,
      prevRank: standings.prevRank,
      standingStatus: standings.status,
      reviewState: users.reviewState,
      manualOnly: sql<boolean>`exists(select 1 from usage_events ue where ue.user_id=${users.id} and not ue.sig_ok)
        and not exists(select 1 from usage_events ue where ue.user_id=${users.id} and ue.sig_ok)`,
      visibility: arenaMembers.visibility,
      status: arenaMembers.status,
    })
    .from(standings)
    .innerJoin(users, eq(users.id, standings.userId))
    .innerJoin(
      arenaMembers,
      and(
        eq(arenaMembers.userId, standings.userId),
        eq(arenaMembers.arenaId, arena.id),
      ),
    )
    .where(eq(standings.seasonId, season.id))
    .orderBy(asc(standings.rank));

  // `#2` — hidden members are absent, not merely unnamed.
  const active = rows.filter((r) => r.status !== "left");
  const visible = active.filter((r) => r.visibility !== "hidden");

  // Members who have never scored have no `standings` row yet, so the join
  // above misses them. Count membership directly or a fresh club looks empty.
  // `#5.2` — titles go by position among members still in contention, so an
  // eliminated member keeps their place on the board without being Sovereign.
  const contenders = visible.filter(
    (r) =>
      r.standingStatus !== "eliminated" &&
      r.reviewState !== "shadow_frozen" &&
      !r.manualOnly,
  ).length;
  let contentionSeen = 0;

  const mapped = visible.map((r) => {
    const anonymous = r.visibility === "anonymous";
    const rank = r.rank ?? 0;
    const eliminated = r.standingStatus === "eliminated";
    const contentionRank =
      eliminated || r.reviewState === "shadow_frozen" || r.manualOnly
        ? null
        : ++contentionSeen;

    return {
      userId: r.userId,
      handle: anonymous ? null : r.handle,
      displayName: null,
      avatarUrl: anonymous ? null : r.avatarUrl,
      pseudonym: anonymous ? pseudonymFor(r.userId) : null,
      points: r.points,
      rank,
      prevRank: r.prevRank,
      // Positive = moved up the board.
      movement: r.prevRank === null ? null : r.prevRank - rank,
      trustTier: r.manualOnly
        ? ("unverified" as const)
        : ("cli_signed" as const),
      underReview: r.reviewState === "shadow_frozen",
      eliminated,
      title:
        contentionRank === null || r.points <= 0
          ? undefined
          : titleForRank(contentionRank, contenders),
    };
  });

  return {
    arena: { slug: arena.slug, name: arena.name, type: arena.type },
    season: {
      idx: season.idx,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
    },
    rows: mapped
      .filter((r) => !options.trust || r.trustTier === options.trust)
      .slice(offset, offset + limit),
    total: mapped.filter((r) => !options.trust || r.trustTier === options.trust)
      .length,
    memberCount: Math.max(Number(memberTally?.n ?? 0), active.length),
    throne: sovereign
      ? {
          userId: sovereign.userId,
          startedAt: sovereign.startedAt,
          heldSeconds: Math.max(
            0,
            Math.floor((now.getTime() - sovereign.startedAt.getTime()) / 1000),
          ),
          // The holder may be anonymous or hidden; take the name from the
          // already visibility-filtered rows rather than from `users`.
          display:
            mapped.find((r) => r.userId === sovereign.userId)?.handle ??
            mapped.find((r) => r.userId === sovereign.userId)?.pseudonym ??
            null,
        }
      : null,
    inviteCode:
      options.viewerId && arena.ownerUserId === options.viewerId
        ? arena.inviteCode
        : null,
  };
}
