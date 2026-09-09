import { and, eq, isNull, sql } from "drizzle-orm";
import type { BridgeSnapshot } from "@usurp/protocol";
import type { Db } from "./client.js";
import { devices, usageBridgeSnapshots } from "./schema.js";
import type { UsageSeriesPoint } from "./profile.js";

export async function saveOwnedBridge(db: Db, userId: string, deviceId: string, snapshot: BridgeSnapshot): Promise<boolean> {
  return db.transaction(async tx => {
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt))).for("update");
    if (!device) return false;
    await tx.insert(usageBridgeSnapshots).values({ deviceId, snapshot }).onConflictDoUpdate({
      target: usageBridgeSnapshots.deviceId, set: { snapshot, importedAt: new Date() },
      setWhere: sql`(${usageBridgeSnapshots.snapshot}->>'fetchedAt')::timestamptz <= ${snapshot.fetchedAt}::timestamptz`,
    });
    return true;
  });
}

type Native = UsageSeriesPoint & { deviceId: string };
/** Replace covered device/agent analytics, not hourly source records. Never max-merge costs. */
export function mergeBridgeSeries(native: Native[], snapshots: Array<{ deviceId: string; snapshot: BridgeSnapshot }>, since?: string): UsageSeriesPoint[] {
  const covered = new Map(snapshots.map(s => [s.deviceId, s.snapshot]));
  const rows: UsageSeriesPoint[] = native.filter(r => {
    const snapshot = covered.get(r.deviceId);
    // Full-history snapshots own covered agents through their import day. We
    // intentionally do not splice newer native costs into that same day.
    return !snapshot || !snapshot.agents.includes(r.agent) || r.day > snapshot.fetchedAt.slice(0, 10);
  }).map(({ deviceId: _, ...r }) => ({ ...r, source: "native" as const }));
  for (const { snapshot } of snapshots) for (const r of snapshot.rows) {
    if (since && r.day < since) continue;
    rows.push({ ...r, effectiveTokens: r.inputTokens + r.outputTokens + r.cacheWriteTokens,
      calls: 0, sessionsStarted: 0, sessionsCompleted: 0, sessionsAbandoned: 0,
      editsApplied: 0, editsReverted: 0, commits: 0, historicalBuckets: 0,
      unpricedBuckets: r.costAvailable ? 0 : 1, source: "agentsview", callsAvailable: false });
  }
  const result = new Map<string, UsageSeriesPoint>();
  for (const r of rows) {
    const key = JSON.stringify([r.day, r.agent, r.model]);
    const prev = result.get(key);
    if (!prev) { result.set(key, { ...r }); continue; }
    for (const k of ["inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "effectiveTokens", "costMicros", "calls", "sessionsStarted", "sessionsCompleted", "sessionsAbandoned", "editsApplied", "editsReverted", "commits", "historicalBuckets", "unpricedBuckets"] as const) prev[k] += r[k];
    prev.callsAvailable = prev.callsAvailable !== false && r.callsAvailable !== false;
    if (prev.source !== r.source) prev.source = "mixed";
  }
  return [...result.values()].sort((a, b) => a.day.localeCompare(b.day) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
}
