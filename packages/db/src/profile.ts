/**
 * Per-user drill-down.
 *
 * The Burn board answers "who burned the most"; this answers "on what". It is
 * the analytics layer `SPEC.md#12` credits AgentsView with — per model, per
 * day, per agent — over data `usage_events` already stores and nothing else
 * reads.
 *
 * ── Visibility is a hard gate, not a filter ─────────────────────────────────
 * Visitors can see only users who are `public` in at least one arena.
 * The authenticated owner can always read their own usage, without competing.
 * An `anonymous` member gets a 404, not a redacted page: `#2` promises they
 * compete under a stable pseudonym, and a profile reachable at `/u/<handle>`
 * would deanonymize them to anyone who guesses the handle — the pseudonym is
 * only unlinkable if the handle route is also closed. A `hidden` member is
 * likewise absent.
 *
 * That means the gate cannot be "does this user exist" (an existence oracle);
 * it has to be "is this user public somewhere", answered identically for
 * absent, hidden, and anonymous users.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  usageEvents,
  users,
  devices,
  usageBridgeSnapshots,
} from "./schema.js";
import { mergeBridgeSeries, selectedBridgeSnapshots } from "./bridge.js";
import { windowStart, type BoardWindow } from "./board.js";

export interface ProfileTotals {
  effectiveTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  calls: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsAbandoned: number;
  editsApplied: number;
  editsReverted: number;
  commits: number;
  costMicros: number;
  /** Distinct hours with any activity — a crude "hours engaged". */
  activeHours: number;
}

export interface ModelBreakdown {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  effectiveTokens: number;
  costMicros: number;
}

export interface DayBreakdown {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  effectiveTokens: number;
  cacheReadTokens: number;
  calls: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsAbandoned: number;
  editsApplied: number;
  commits: number;
  costMicros: number;
}

export interface AgentBreakdown {
  agent: string;
  calls: number;
  effectiveTokens: number;
  costMicros: number;
}

/** Exact bucket identity, exposed for users who want model results per IDE. */
export interface ModelAgentBreakdown extends ModelBreakdown {
  agent: string;
}

/** Daily aggregates only: no project names, session ids, or transcript data. */
export interface UsageSeriesPoint extends ModelAgentBreakdown {
  source?: "native" | "agentsview" | "mixed";
  callsAvailable?: boolean;
  day: string;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsAbandoned: number;
  editsApplied: number;
  editsReverted: number;
  commits: number;
  historicalBuckets: number;
  unpricedBuckets: number;
}

export interface Profile {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: Date;
  window: BoardWindow;
  totals: ProfileTotals;
  byModel: ModelBreakdown[];
  byModelAgent: ModelAgentBreakdown[];
  byDay: DayBreakdown[];
  byAgent: AgentBreakdown[];
  usageSeries: UsageSeriesPoint[];
  /** Preferred-source analytics, separate from native competitive counters. */
  analyticsSeries: UsageSeriesPoint[];
  /** Exact selected bridge exports, without native additions. */
  bridgeSeries: UsageSeriesPoint[];
  bridgeImports: Array<{
    importedAt: string;
    pricingVersion: string;
    agents: string[];
  }>;
  /** Arenas this user is public in — the only ones safe to name. */
  arenas: Array<{
    slug: string;
    name: string;
    type: "global" | "org" | "club";
  }>;
  /** Distinct devices contributing, count only — never ids or keys. */
  deviceCount: number;
  /** Imported archive buckets in the selected analytics window. */
  historicalBuckets: number;
  flagged: boolean;
  trustTier: "unverified" | "cli_signed" | "org_verified";
  firstSeen: Date | null;
  lastSeen: Date | null;
}

/** `#4.2` — input + output + cache_write; cache_read excluded as it is cheap. */
const effective = sql<number>`
  coalesce(sum(${usageEvents.inputTokens}), 0)
  + coalesce(sum(${usageEvents.outputTokens}), 0)
  + coalesce(sum(${usageEvents.cacheWriteTokens}), 0)
`;

export interface ProfileOptions {
  /** Trusted server-session user ID only; never accept this from request input. */
  viewerId?: string;
  /** Dashboard uses complete UTC days; daily bridges cannot resolve rolling hours. */
  dailyAnalytics?: boolean;
  window?: BoardWindow;
  now?: Date;
}

export async function userProfile(
  db: Db,
  handle: string,
  options: ProfileOptions = {},
): Promise<Profile | undefined> {
  return readProfile(db, handle, options, true);
}

/** The dashboard does not consume the API's four standalone breakdowns. */
export type DashboardProfile = Omit<Profile, "byModel" | "byDay" | "byAgent" | "byModelAgent">;

export async function userDashboard(
  db: Db,
  handle: string,
  options: ProfileOptions = {},
): Promise<DashboardProfile | undefined> {
  const profile = await readProfile(db, handle, { ...options, dailyAnalytics: true }, false);
  if (!profile) return undefined;
  const { byModel, byDay, byAgent, byModelAgent, ...dashboard } = profile;
  return dashboard;
}

async function readProfile(
  db: Db,
  handle: string,
  options: ProfileOptions,
  breakdowns: boolean,
): Promise<Profile | undefined> {
  const window = options.window ?? "week";
  let since = windowStart(window, options.now);
  if (options.dailyAnalytics && since) {
    const today = new Date(options.now ?? new Date());
    today.setUTCHours(0, 0, 0, 0);
    since = new Date(
      +today - (window === "day" ? 0 : window === "week" ? 6 : 29) * 86400_000,
    );
  }

  // Case-insensitive, matching the `lower(handle)` unique index — otherwise
  // `/u/Kenn` and `/u/kenn` disagree about who exists.
  // Lookup and arena visibility share one round trip. The correlated subquery
  // returns only arena names this viewer may see; no usage is read until the
  // owner/public-membership gate below has passed.
  const [identity] = await db
    .select({
      user: users,
      visibleArenas: sql<Profile["arenas"]>`coalesce((
        select jsonb_agg(jsonb_build_object('slug', a.slug, 'name', a.name, 'type', a.type))
        from arena_members m inner join arenas a on a.id = m.arena_id
        where m.user_id = "users"."id"
          and m.visibility = 'public' and m.status <> 'left'
          and (a.type = 'global' or "users"."id"::text = ${options.viewerId ?? ""}
            or a.owner_user_id::text = ${options.viewerId ?? ""}
            or exists(select 1 from arena_members viewer_member where viewer_member.arena_id=a.id
              and viewer_member.user_id::text=${options.viewerId ?? ""} and viewer_member.status <> 'left'))
      ), '[]'::jsonb)`,
    })
    .from(users)
    .where(sql`lower(${users.handle}) = lower(${handle})`)
    .limit(1);

  if (!identity) return undefined;
  const { user, visibleArenas } = identity;

  if (visibleArenas.length === 0 && options.viewerId !== user.id)
    return undefined;

  const scope = since
    ? and(eq(usageEvents.userId, user.id), gte(usageEvents.hour, since))
    : eq(usageEvents.userId, user.id);

  // Build lazy queries only after authorization. Await them together below so
  // independent summaries do not serialize app-to-database network latency.
  const totalsQuery = db
    .select({
      effective,
      input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheWrite: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      cacheRead: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      sessionsStarted: sql<number>`coalesce(sum(${usageEvents.sessionsStarted}), 0)`,
      sessionsCompleted: sql<number>`coalesce(sum(${usageEvents.sessionsCompleted}), 0)`,
      sessionsAbandoned: sql<number>`coalesce(sum(${usageEvents.sessionsAbandoned}), 0)`,
      editsApplied: sql<number>`coalesce(sum(${usageEvents.editsApplied}), 0)`,
      editsReverted: sql<number>`coalesce(sum(${usageEvents.editsReverted}), 0)`,
      commits: sql<number>`coalesce(sum(${usageEvents.commits}), 0)`,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
      activeHours: sql<number>`count(distinct ${usageEvents.hour})::int`,
      devices: sql<number>`count(distinct ${usageEvents.deviceId})::int`,
      historicalBuckets: sql<number>`count(*) filter (where ${usageEvents.historical})::int`,
      flagged: sql<boolean>`coalesce(bool_or(jsonb_array_length(${usageEvents.flags}) > 0), false)`,
      firstSeen: sql<Date | null>`min(${usageEvents.hour})`,
      lastSeen: sql<Date | null>`max(${usageEvents.hour})`,
    })
    .from(usageEvents)
    .where(scope);

  const byModelQuery = db
    .select({
      model: usageEvents.model,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheWrite: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      cacheRead: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      effective,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .where(scope)
    .groupBy(usageEvents.model)
    .orderBy(sql`8 desc`);

  // `date_trunc` on a timestamptz uses the session TimeZone, which would make
  // day boundaries depend on where the server runs. `AT TIME ZONE 'UTC'` pins
  // them to the same UTC days the buckets were built on.
  const dayExpr = sql<string>`to_char(${usageEvents.hour} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  const byDayQuery = db
    .select({
      day: dayExpr,
      effective,
      cacheRead: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      sessionsStarted: sql<number>`coalesce(sum(${usageEvents.sessionsStarted}), 0)`,
      sessionsCompleted: sql<number>`coalesce(sum(${usageEvents.sessionsCompleted}), 0)`,
      sessionsAbandoned: sql<number>`coalesce(sum(${usageEvents.sessionsAbandoned}), 0)`,
      editsApplied: sql<number>`coalesce(sum(${usageEvents.editsApplied}), 0)`,
      commits: sql<number>`coalesce(sum(${usageEvents.commits}), 0)`,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .where(scope)
    .groupBy(dayExpr)
    .orderBy(sql`1 desc`);

  const byAgentQuery = db
    .select({
      agent: usageEvents.agent,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      effective,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .where(scope)
    .groupBy(usageEvents.agent)
    .orderBy(sql`3 desc`);

  // Do not derive this from the two independent summaries above: a model can
  // be used by several IDEs, and the bucket identity is explicitly
  // `(hour, agent, model)` in SPEC.md#3.3.
  const byModelAgentQuery = db
    .select({
      agent: usageEvents.agent,
      model: usageEvents.model,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheWrite: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      cacheRead: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      effective,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .where(scope)
    .groupBy(usageEvents.agent, usageEvents.model)
    .orderBy(sql`9 desc`, usageEvents.agent, usageEvents.model);

  // The chart needs the joint distribution. Separate by-day and by-model
  // totals cannot tell us which model generated a particular day's activity.
  const seriesQuery = db
    .select({
      deviceId: usageEvents.deviceId,
      day: dayExpr,
      agent: usageEvents.agent,
      model: usageEvents.model,
      inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheWriteTokens: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      cacheReadTokens: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      effectiveTokens: effective,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      costMicros: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
      sessionsStarted: sql<number>`coalesce(sum(${usageEvents.sessionsStarted}), 0)`,
      sessionsCompleted: sql<number>`coalesce(sum(${usageEvents.sessionsCompleted}), 0)`,
      sessionsAbandoned: sql<number>`coalesce(sum(${usageEvents.sessionsAbandoned}), 0)`,
      editsApplied: sql<number>`coalesce(sum(${usageEvents.editsApplied}), 0)`,
      editsReverted: sql<number>`coalesce(sum(${usageEvents.editsReverted}), 0)`,
      commits: sql<number>`coalesce(sum(${usageEvents.commits}), 0)`,
      historicalBuckets: sql<number>`count(*) filter (where ${usageEvents.historical})::int`,
      unpricedBuckets: sql<number>`count(*) filter (where ${usageEvents.flags} @> '["unknown_model"]'::jsonb)::int`,
    })
    .from(usageEvents)
    .where(scope)
    .groupBy(
      dayExpr,
      usageEvents.deviceId,
      usageEvents.agent,
      usageEvents.model,
    )
    .orderBy(dayExpr, usageEvents.agent, usageEvents.model);

  const snapshotsQuery = options.dailyAnalytics
    ? db
        .select({
          deviceId: devices.id,
          snapshot: usageBridgeSnapshots.snapshot,
          importedAt: usageBridgeSnapshots.importedAt,
        })
        .from(usageBridgeSnapshots)
        .innerJoin(devices, eq(devices.id, usageBridgeSnapshots.deviceId))
        .where(eq(devices.userId, user.id))
    : [];
  const [[t], byModel, byDay, byAgent, byModelAgent, series, snapshots] =
    await Promise.all([
      totalsQuery,
      breakdowns ? byModelQuery : [],
      breakdowns ? byDayQuery : [],
      breakdowns ? byAgentQuery : [],
      breakdowns ? byModelAgentQuery : [],
      seriesQuery,
      snapshotsQuery,
    ]);
  const n = (v: unknown) => Number(v ?? 0);
  const normalized = series.map((r) => ({
    ...r,
    ...Object.fromEntries(
      Object.entries(r)
        .filter(([k]) => !["day", "agent", "model", "deviceId"].includes(k))
        .map(([k, v]) => [k, n(v)]),
    ),
  })) as Array<UsageSeriesPoint & { deviceId: string }>;
  const analyticsSeries = mergeBridgeSeries(
    normalized,
    snapshots,
    since?.toISOString().slice(0, 10),
  );
  return {
    handle: user.handle,
    displayName: null,
    avatarUrl: user.avatarUrl,
    joinedAt: user.createdAt,
    window,
    bridgeImports: selectedBridgeSnapshots(snapshots).map((s) => ({
      importedAt: s.importedAt.toISOString(),
      pricingVersion: s.snapshot.pricingVersion,
      agents: s.snapshot.agents,
    })),
    analyticsSeries,
    bridgeSeries: mergeBridgeSeries(
      [],
      snapshots,
      since?.toISOString().slice(0, 10),
    ),
    usageSeries: mergeBridgeSeries(normalized, []),
    totals: {
      effectiveTokens: n(t?.effective),
      inputTokens: n(t?.input),
      outputTokens: n(t?.output),
      cacheWriteTokens: n(t?.cacheWrite),
      cacheReadTokens: n(t?.cacheRead),
      calls: n(t?.calls),
      sessionsStarted: n(t?.sessionsStarted),
      sessionsCompleted: n(t?.sessionsCompleted),
      sessionsAbandoned: n(t?.sessionsAbandoned),
      editsApplied: n(t?.editsApplied),
      editsReverted: n(t?.editsReverted),
      commits: n(t?.commits),
      costMicros: n(t?.cost),
      activeHours: n(t?.activeHours),
    },
    byModel: byModel.map((r) => ({
      model: r.model,
      calls: n(r.calls),
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheWriteTokens: n(r.cacheWrite),
      cacheReadTokens: n(r.cacheRead),
      effectiveTokens: n(r.effective),
      costMicros: n(r.cost),
    })),
    byModelAgent: byModelAgent.map((r) => ({
      agent: r.agent,
      model: r.model,
      calls: n(r.calls),
      inputTokens: n(r.input),
      outputTokens: n(r.output),
      cacheWriteTokens: n(r.cacheWrite),
      cacheReadTokens: n(r.cacheRead),
      effectiveTokens: n(r.effective),
      costMicros: n(r.cost),
    })),
    byDay: byDay.map((r) => ({
      day: r.day,
      effectiveTokens: n(r.effective),
      cacheReadTokens: n(r.cacheRead),
      calls: n(r.calls),
      sessionsStarted: n(r.sessionsStarted),
      sessionsCompleted: n(r.sessionsCompleted),
      sessionsAbandoned: n(r.sessionsAbandoned),
      editsApplied: n(r.editsApplied),
      commits: n(r.commits),
      costMicros: n(r.cost),
    })),
    byAgent: byAgent.map((r) => ({
      agent: r.agent,
      calls: n(r.calls),
      effectiveTokens: n(r.effective),
      costMicros: n(r.cost),
    })),
    arenas: visibleArenas,
    deviceCount: new Set([
      ...normalized.map((r) => r.deviceId),
      ...snapshots
        .filter((s) =>
          s.snapshot.rows.some(
            (r) => !since || r.day >= since.toISOString().slice(0, 10),
          ),
        )
        .map((s) => s.deviceId),
    ]).size,
    historicalBuckets: n(t?.historicalBuckets),
    flagged: Boolean(t?.flagged) || user.reviewState === "shadow_frozen",
    // M0 registers every device as `cli_signed`; the column is authoritative
    // once manual upload and org verification land.
    trustTier: "cli_signed",
    firstSeen: t?.firstSeen ? new Date(t.firstSeen) : null,
    lastSeen: t?.lastSeen ? new Date(t.lastSeen) : null,
  };
}

/**
 * Derived ratios, for display only.
 *
 * `#4.2`'s efficiency signals, computed but deliberately **not** scored: M2
 * owns the rating engine and its `#4.4` simulation gate. Showing them now is
 * how you find out whether they discriminate at all before weighting them —
 * and `cacheReuse` is here in the form the gates note argues for, because
 * `cache_read / (input + cache_read)` pins to ~0.9999 and says nothing.
 */
export function derivedSignals(totals: ProfileTotals) {
  const {
    cacheReadTokens,
    cacheWriteTokens,
    sessionsStarted,
    sessionsCompleted,
  } = totals;

  const cacheDenominator = cacheReadTokens + cacheWriteTokens;
  const sessionDenominator = sessionsStarted;

  return {
    /** Reuse vs re-caching — where the money actually goes. */
    cacheReuse:
      cacheDenominator > 0 ? cacheReadTokens / cacheDenominator : null,
    /** `#4.2` completion: punishes abandoned thrash loops. */
    completion:
      sessionDenominator > 0 ? sessionsCompleted / sessionDenominator : null,
    /** `#4.2` yield: commits per million effective tokens. */
    yieldPerMTok:
      totals.effectiveTokens > 0
        ? totals.commits / (totals.effectiveTokens / 1_000_000)
        : null,
    /** Edits that stuck, as a share of all edit attempts. */
    editStickiness:
      totals.editsApplied + totals.editsReverted > 0
        ? totals.editsApplied / (totals.editsApplied + totals.editsReverted)
        : null,
  };
}
