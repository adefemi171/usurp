import { inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { usageEvents, devices, usageBridgeSnapshots } from "./schema.js";

/** Display-only activity; never changes scoring or infers work time. */
export async function arenaActivity(db: Db, userIds: string[], toolUserIds: string[], now: Date) {
  const result = new Map<string, { streakDays: number; tools: string[] }>();
  for (const id of userIds) result.set(id, { streakDays: 0, tools: [] });
  if (!userIds.length) return result;
  const today = now.toISOString().slice(0, 10);
  const recent = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);

  // One UTC date per user across all devices. Row numbers identify consecutive
  // runs without capping the displayed streak at the scoring multiplier's cap.
  // Yesterday's streak survives until the current UTC day has finished.
  const streaks = db.execute<{ user_id: string; days: number }>(sql`
    with active_days as (
      select distinct ${usageEvents.userId} as user_id,
        (${usageEvents.hour} at time zone 'UTC')::date as day
      from ${usageEvents}
      where ${inArray(usageEvents.userId, userIds)}
        and ${usageEvents.sigOk} and not ${usageEvents.historical}
        and ${usageEvents.hour} <= ${now.toISOString()}::timestamptz
        and (${usageEvents.inputTokens} > 0 or ${usageEvents.outputTokens} > 0
          or ${usageEvents.cacheWriteTokens} > 0 or ${usageEvents.calls} > 0)
    ), numbered as (
      select user_id, day, day + (row_number() over (partition by user_id order by day desc))::int as run
      from active_days
    )
    select user_id, count(*)::int as days from numbered
    group by user_id, run
    having max(day) >= ${today}::date - 1
  `);

  // Fetch only opted-in public members. Bridge summaries are analytics-only:
  // their measured tools can be shown, but they never earn competitive streaks.
  const tools = toolUserIds.length ? db.execute<{ user_id: string; agent: string }>(sql`
    select distinct ${usageEvents.userId} as user_id, ${usageEvents.agent} as agent
    from ${usageEvents}
    where ${inArray(usageEvents.userId, toolUserIds)} and ${usageEvents.sigOk}
      and ${usageEvents.hour} >= ${`${recent}T00:00:00Z`}::timestamptz
      and ${usageEvents.hour} <= ${now.toISOString()}::timestamptz
      and (${usageEvents.inputTokens} > 0 or ${usageEvents.outputTokens} > 0
        or ${usageEvents.cacheWriteTokens} > 0 or ${usageEvents.cacheReadTokens} > 0 or ${usageEvents.calls} > 0)
    union
    select ${devices.userId} as user_id, entry->>'agent' as agent
    from ${usageBridgeSnapshots} inner join ${devices} on ${devices.id} = ${usageBridgeSnapshots.deviceId}
      cross join lateral jsonb_array_elements(${usageBridgeSnapshots.snapshot}->'rows') entry
    where ${inArray(devices.userId, toolUserIds)}
      and entry->>'day' >= ${recent} and entry->>'day' <= ${today}
      and ((entry->>'inputTokens')::bigint > 0 or (entry->>'outputTokens')::bigint > 0
        or (entry->>'cacheWriteTokens')::bigint > 0 or (entry->>'cacheReadTokens')::bigint > 0)
  `) : Promise.resolve([]);
  const [streakRows, toolRows] = await Promise.all([streaks, tools]);
  for (const row of streakRows) result.get(row.user_id)!.streakDays = Number(row.days);
  for (const row of toolRows) result.get(row.user_id)?.tools.push(row.agent);
  for (const value of result.values()) value.tools.sort();
  return result;
}
