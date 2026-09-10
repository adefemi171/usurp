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
type StoredSnapshot = { deviceId: string; snapshot: BridgeSnapshot };
type SnapshotGroup<T extends StoredSnapshot> = { selected: T; deviceIds: Set<string> };

/**
 * A bridge is a full account-level AgentsView export, rather than a device
 * counter. Prefer the newest copy from a stable local source, so installing
 * Connect beside the CLI cannot double a user's historical usage. Before
 * source IDs were introduced, there is no safe way to tell two full exports
 * apart, so treat legacy snapshots as one source and prefer its newest copy.
 */
function distinctSnapshots<T extends StoredSnapshot>(snapshots: T[]): SnapshotGroup<T>[] {
  // Upgrade compatibility: the original CLI did not send sourceId. When the
  // account has one identified source, its legacy exports belong to that same
  // source, not an additional billable source. Keep every device in the group
  // so its native overlap is also replaced by the selected snapshot.
  const knownSources = new Set(snapshots.flatMap(s => s.snapshot.sourceId ? [s.snapshot.sourceId] : []));
  const legacySource = knownSources.size === 1 ? [...knownSources][0]! : "legacy:agentsview";
  const bySource = new Map<string, SnapshotGroup<T>>();
  for (const entry of snapshots) {
    const sourceId = entry.snapshot.sourceId ?? legacySource;
    const existing = bySource.get(sourceId);
    if (!existing) {
      bySource.set(sourceId, { selected: entry, deviceIds: new Set([entry.deviceId]) });
      continue;
    }
    existing.deviceIds.add(entry.deviceId);
    if (existing.selected.snapshot.fetchedAt < entry.snapshot.fetchedAt) existing.selected = entry;
  }
  return [...bySource.values()];
}

/** UI freshness must describe the snapshots actually used in the totals. */
export function selectedBridgeSnapshots<T extends StoredSnapshot>(snapshots: T[]): T[] {
  return distinctSnapshots(snapshots).map(group => group.selected);
}

/** Replace covered device/agent analytics, not hourly source records. Never max-merge costs. */
export function mergeBridgeSeries(native: Native[], snapshots: Array<{ deviceId: string; snapshot: BridgeSnapshot }>, since?: string): UsageSeriesPoint[] {
  const selectedSnapshots = distinctSnapshots(snapshots);
  const covered = new Map<string, BridgeSnapshot>();
  for (const group of selectedSnapshots) for (const deviceId of group.deviceIds) covered.set(deviceId, group.selected.snapshot);
  const rows: UsageSeriesPoint[] = native.filter(r => {
    const snapshot = covered.get(r.deviceId);
    // Full-history snapshots own covered agents through their import day. We
    // intentionally do not splice newer native costs into that same day.
    return !snapshot || !snapshot.agents.includes(r.agent) || r.day > snapshot.fetchedAt.slice(0, 10);
  }).map(({ deviceId: _, ...r }) => ({ ...r, source: "native" as const }));
  for (const { selected: { snapshot } } of selectedSnapshots) for (const r of snapshot.rows) {
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
