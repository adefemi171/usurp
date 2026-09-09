import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateDeviceKeyPair, signPayload, type BridgeSnapshot } from "@usurp/protocol";
import { mergeBridgeSeries, saveOwnedBridge } from "./bridge.js";
import { getDb, closeDb } from "./client.js";
import { devices, users, usageBridgeSnapshots, usageEvents } from "./schema.js";
import { ingest } from "./ingest.js";
import { userProfile, type UsageSeriesPoint } from "./profile.js";
import { joinGlobalArena } from "./seed.js";

const now = new Date("2026-09-09T12:00:00Z");
function snapshot(cost = 100): BridgeSnapshot { return {
  source: "agentsview", schemaVersion: 6, fetchedAt: now.toISOString(), timezone: "UTC", pricingVersion: "historical", costBasis: "source-calculated", agents: ["codex"],
  rows: [{ day: "2026-09-09", agent: "codex", model: "model", inputTokens: 5, outputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 20, costMicros: cost, costAvailable: true }],
}; }
function native(agent = "codex", deviceId = "a"): UsageSeriesPoint & { deviceId: string } { return {
  deviceId, day: "2026-09-09", agent, model: "model", inputTokens: 10, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, costMicros: 200, effectiveTokens: 20,
  calls: 1, sessionsStarted: 1, sessionsCompleted: 0, sessionsAbandoned: 0, editsApplied: 0, editsReverted: 0, commits: 0, historicalBuckets: 0, unpricedBuckets: 0,
}; }
describe("preferred-source analytics", () => {
  it("replaces covered sources without double-counting and retains native Cursor", () => {
    const rows = mergeBridgeSeries([native(), native("cursor")], [{ deviceId: "a", snapshot: snapshot() }]);
    expect(rows.reduce((n, r) => n + r.costMicros, 0)).toBe(300);
    expect(rows.find(r => r.agent === "codex")).toMatchObject({ calls: 0, callsAvailable: false, effectiveTokens: 10 });
    expect(rows.find(r => r.agent === "cursor")?.calls).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("deviceId");
  });
  it("does not suppress another device and merges shared keys", () => {
    const rows = mergeBridgeSeries([native(), native("codex", "b")], [{ deviceId: "a", snapshot: snapshot() }]);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ costMicros: 300, source: "mixed", callsAvailable: false });
  });
  it("uses the newest snapshot from the same local AgentsView source", () => {
    const old = { ...snapshot(100), sourceId: "agentsview:local:8080" as const, fetchedAt: "2026-09-08T12:00:00.000Z" };
    const fresh = { ...snapshot(250), sourceId: "agentsview:local:8080" as const, fetchedAt: "2026-09-09T12:00:00.000Z" };
    const rows = mergeBridgeSeries([], [{ deviceId: "old-cli", snapshot: old }, { deviceId: "connect", snapshot: fresh }]);
    expect(rows).toHaveLength(1); expect(rows[0]?.costMicros).toBe(250);
  });
  it("uses only the newest legacy full export and replaces both clients' native overlap", () => {
    const old = { ...snapshot(100), fetchedAt: "2026-09-08T12:00:00.000Z", rows: [{ ...snapshot().rows[0]!, day: "2026-09-08" }] };
    const fresh = snapshot(200);
    const rows = mergeBridgeSeries([native("codex", "a"), native("codex", "b")], [{ deviceId: "a", snapshot: old }, { deviceId: "b", snapshot: fresh }]);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ costMicros: 200, source: "agentsview" });
  });
  it("keeps snapshot precedence until its import day, then permits native fallback", () => {
    const rows = mergeBridgeSeries([{ ...native(), day: "2026-09-10" }], [{ deviceId: "a", snapshot: snapshot() }], "2026-09-10");
    expect(rows).toHaveLength(1); expect(rows[0]?.source).toBe("native");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("bridge persistence", () => {
  afterAll(closeDb);
  it("supports signed imports, downward corrections, replay protection, ownership and native isolation", async () => {
    const db = getDb(); const keys = generateDeviceKeyPair();
    const [user] = await db.insert(users).values({ handle: `bridge_${Date.now()}` }).returning();
    const id = `bridge_${Date.now()}`;
    try {
      await db.insert(devices).values({ id, userId: user!.id, publicKey: keys.publicKey });
      await joinGlobalArena(db, user!.id);
      const payload = (seq: number, cost: number) => signPayload({ v: 1, device_id: id, seq, submitted_at: now.toISOString(), reader_revision: 2, buckets: [], bridge: snapshot(cost) }, keys.privateKeyPem);
      expect((await ingest(db, payload(1, 100), { now })).ok).toBe(true);
      expect((await ingest(db, payload(1, 100), { now })).failure).toBe("stale_seq");
      expect((await ingest(db, payload(2, 50), { now })).ok).toBe(true);
      const [stored] = await db.select().from(usageBridgeSnapshots).where(eq(usageBridgeSnapshots.deviceId, id));
      expect(stored?.snapshot.rows[0]?.costMicros).toBe(50);
      expect(await db.select().from(usageEvents).where(eq(usageEvents.deviceId, id))).toHaveLength(0);
      expect(await saveOwnedBridge(db, "00000000-0000-0000-0000-000000000001", id, snapshot())).toBe(false);
      expect(await saveOwnedBridge(db, user!.id, id, { ...snapshot(500), fetchedAt: "2026-09-08T12:00:00.000Z", rows: [{ ...snapshot().rows[0]!, day: "2026-09-08" }] })).toBe(true);
      const p = await userProfile(db, user!.handle, { window: "day", dailyAnalytics: true, now });
      expect(p?.analyticsSeries[0]?.costMicros).toBe(50);
      expect(p?.deviceCount).toBe(1);
      expect(p?.usageSeries).toHaveLength(0);
      const invalid = payload(3, 500); invalid.bridge!.rows[0]!.costMicros++;
      expect((await ingest(db, invalid, { now })).failure).toBe("bad_signature");
      await db.update(devices).set({ revokedAt: now }).where(eq(devices.id, id));
      expect(await saveOwnedBridge(db, user!.id, id, snapshot())).toBe(false);
      expect((await ingest(db, payload(3, 500), { now })).failure).toBe("device_revoked");
    } finally { await db.delete(users).where(eq(users.id, user!.id)); }
  });
});
