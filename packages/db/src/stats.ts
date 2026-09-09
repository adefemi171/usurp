/**
 * Headline numbers for the hero strip.
 *
 * Every figure here is honest by construction: it is a sum over
 * `usage_events`, which only ever holds signed, gate-checked aggregate
 * counters. Nothing is inflated for effect, and the cost column is explicitly
 * an estimate at list price (`models.ts`).
 *
 * `#2` visibility does **not** filter these, deliberately — an aggregate over
 * the whole platform reveals no individual, which is the same reasoning that
 * lets `#2` give org admins aggregates while withholding per-member rows.
 * Anything scoped tightly enough to identify someone belongs on a board, not
 * in a headline.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { arenaMembers, arenas, usageEvents, users } from "./schema.js";

export interface PlatformStats {
  /** Accounts with at least one synced bucket. */
  competitors: number;
  effectiveTokens: number;
  cacheReadTokens: number;
  costMicros: number;
  calls: number;
  commits: number;
  /** Distinct UTC days with any activity. */
  activeDays: number;
}

export async function platformStats(
  db: Db,
  options: { since?: Date } = {},
): Promise<PlatformStats> {
  const where = options.since ? gte(usageEvents.hour, options.since) : undefined;

  const [row] = await db
    .select({
      competitors: sql<number>`count(distinct ${usageEvents.userId})::int`,
      effective: sql<string>`coalesce(sum(
        ${usageEvents.inputTokens} + ${usageEvents.outputTokens} + ${usageEvents.cacheWriteTokens}
      ), 0)`,
      cacheRead: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
      calls: sql<string>`coalesce(sum(${usageEvents.calls}), 0)`,
      commits: sql<string>`coalesce(sum(${usageEvents.commits}), 0)`,
      activeDays: sql<number>`count(distinct date_trunc('day', ${usageEvents.hour} AT TIME ZONE 'UTC'))::int`,
    })
    .from(usageEvents)
    .where(where);

  const n = (v: unknown) => Number(v ?? 0);

  return {
    competitors: n(row?.competitors),
    effectiveTokens: n(row?.effective),
    cacheReadTokens: n(row?.cacheRead),
    costMicros: n(row?.cost),
    calls: n(row?.calls),
    commits: n(row?.commits),
    activeDays: n(row?.activeDays),
  };
}

export interface ArenaStats extends PlatformStats {
  /** Active members, whether or not they have synced. */
  members: number;
}

export async function arenaStats(
  db: Db,
  slug: string,
  options: { since?: Date } = {},
): Promise<ArenaStats | undefined> {
  const [arena] = await db.select().from(arenas).where(eq(arenas.slug, slug)).limit(1);
  if (!arena) return undefined;

  const memberRows = await db
    .select({ userId: arenaMembers.userId })
    .from(arenaMembers)
    .where(
      and(eq(arenaMembers.arenaId, arena.id), sql`${arenaMembers.status} <> 'left'`),
    );

  const memberIds = memberRows.map((m) => m.userId);
  if (memberIds.length === 0) {
    return {
      members: 0,
      competitors: 0,
      effectiveTokens: 0,
      cacheReadTokens: 0,
      costMicros: 0,
      calls: 0,
      commits: 0,
      activeDays: 0,
    };
  }

  const conditions = [
    sql`${usageEvents.userId} in ${memberIds}`,
    ...(options.since ? [gte(usageEvents.hour, options.since)] : []),
  ];

  const [row] = await db
    .select({
      competitors: sql<number>`count(distinct ${usageEvents.userId})::int`,
      effective: sql<string>`coalesce(sum(
        ${usageEvents.inputTokens} + ${usageEvents.outputTokens} + ${usageEvents.cacheWriteTokens}
      ), 0)`,
      cacheRead: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      cost: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
      calls: sql<string>`coalesce(sum(${usageEvents.calls}), 0)`,
      commits: sql<string>`coalesce(sum(${usageEvents.commits}), 0)`,
      activeDays: sql<number>`count(distinct date_trunc('day', ${usageEvents.hour} AT TIME ZONE 'UTC'))::int`,
    })
    .from(usageEvents)
    .where(and(...conditions));

  const n = (v: unknown) => Number(v ?? 0);

  return {
    members: memberIds.length,
    competitors: n(row?.competitors),
    effectiveTokens: n(row?.effective),
    cacheReadTokens: n(row?.cacheRead),
    costMicros: n(row?.cost),
    calls: n(row?.calls),
    commits: n(row?.commits),
    activeDays: n(row?.activeDays),
  };
}

/** Total accounts, for a "N developers" style figure. */
export async function accountCount(db: Db): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return Number(row?.n ?? 0);
}
