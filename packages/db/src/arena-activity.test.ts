import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateDeviceKeyPair } from "@usurp/protocol";
import { getDb, closeDb } from "./client.js";
import { arenaActivity } from "./arena-activity.js";
import { arenas, arenaMembers, users, devices, usageEvents, dailyScores, usageBridgeSnapshots } from "./schema.js";
import { setToolSharing, setVisibility, leaveArena, membershipsFor } from "./arenas.js";
import { ratingBoard, recomputeStandings } from "./rating.js";
import { ensureCurrentSeason } from "./seasons.js";

const now = new Date("2026-09-20T12:00:00Z");
describe.skipIf(!process.env.DATABASE_URL)("arena streaks and tool privacy", () => {
  const userIds: string[] = []; const arenaIds: string[] = [];
  const db = process.env.DATABASE_URL ? getDb() : (undefined as never);
  afterEach(async () => {
    for (const id of arenaIds.splice(0)) await db.delete(arenas).where(eq(arenas.id, id));
    for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id));
  });
  afterAll(closeDb);
  async function member() {
    const [u] = await db.insert(users).values({ handle: `ac${randomUUID().slice(0, 8)}` }).returning();
    userIds.push(u!.id);
    const ds = [randomUUID(), randomUUID()];
    await db.insert(devices).values(ds.map(id => ({ id, userId: u!.id, publicKey: generateDeviceKeyPair().publicKey })));
    return { id: u!.id, devices: ds };
  }
  async function event(u: Awaited<ReturnType<typeof member>>, day: string, extra: Partial<typeof usageEvents.$inferInsert> = {}) {
    await db.insert(usageEvents).values({ userId: u.id, deviceId: u.devices[0]!, hour: new Date(`${day}T01:00:00Z`),
      agent: "codex", model: "test-model", inputTokens: 100, calls: 1, sigOk: true, dedupeKey: randomUUID(), ...extra });
  }
  async function arena(ids: string[]) {
    const [a] = await db.insert(arenas).values({ name: "Activity test", slug: `ac-${randomUUID()}`, type: "club" }).returning();
    arenaIds.push(a!.id);
    await db.insert(arenaMembers).values(ids.map(userId => ({ userId, arenaId: a!.id })));
    await db.insert(dailyScores).values(ids.map(userId => ({ userId, day: new Date("2026-09-20T00:00:00Z"), points: 100 }))).onConflictDoNothing();
    await recomputeStandings(db, a!.id, await ensureCurrentSeason(db, a!.id, now), now);
    return a!;
  }
  it("counts long runs once per UTC day across devices, not scoring's capped lookback", async () => {
    const u = await member();
    for (let i = 0; i < 35; i++) await event(u, new Date(+now - i * 86400000).toISOString().slice(0, 10));
    await event(u, "2026-09-20", { deviceId: u.devices[1]! });
    expect((await arenaActivity(db, [u.id], [], now)).get(u.id)).toEqual({ streakDays: 35, tools: [] });
  });
  it("keeps yesterday's streak until UTC day end; ignores future, unsigned, historical and metadata-only events", async () => {
    const u = await member();
    await event(u, "2026-09-19"); await event(u, "2026-09-17");
    await event(u, "2026-09-18", { historical: true });
    await event(u, "2026-09-18", { sigOk: false });
    await event(u, "2026-09-18", { calls: 0, inputTokens: 0 });
    await event(u, "2026-09-21");
    expect((await arenaActivity(db, [u.id], [], new Date("2026-09-20T00:00:00Z"))).get(u.id)!.streakDays).toBe(1);
    expect((await arenaActivity(db, [u.id], [], new Date("2026-09-21T00:00:00Z"))).get(u.id)!.streakDays).toBe(0);
  });
  it("exposes measured recent tools only with per-arena consent, never for anonymous/hidden members", async () => {
    const u = await member(); const other = await member();
    const a = await arena([u.id, other.id]); const b = await arena([u.id, other.id]);
    await event(u, "2026-09-20"); await event(u, "2026-09-19", { agent: "cursor" });
    await event(u, "2026-08-01", { agent: "old-tool" });
    await event(u, "2026-09-19", { agent: "metadata-only", inputTokens: 0, calls: 0 });
    expect((await ratingBoard(db, a.slug, { now }))!.rows.find(r => r.userId === u.id)!.tools).toEqual([]);
    await setToolSharing(db, u.id, a.id, true);
    const row = (await ratingBoard(db, a.slug, { now }))!.rows.find(r => r.userId === u.id)!;
    expect(row.tools).toEqual(["codex", "cursor"]); expect(row.streakDays).toBe(2);
    expect((await ratingBoard(db, b.slug, { now }))!.rows.find(r => r.userId === u.id)!.tools).toEqual([]);
    await setVisibility(db, u.id, a.id, "anonymous");
    const anonymous = (await ratingBoard(db, a.slug, { now }))!.rows.find(r => r.userId === u.id)!;
    expect(anonymous.handle).toBeNull(); expect(anonymous.tools).toEqual([]);
    await setVisibility(db, u.id, a.id, "hidden");
    expect((await ratingBoard(db, a.slug, { now }))!.rows.some(r => r.userId === u.id)).toBe(false);
    await setVisibility(db, u.id, a.id, "public");
    await setToolSharing(db, u.id, a.id, false);
    expect((await ratingBoard(db, a.slug, { now }))!.rows.find(r => r.userId === u.id)!.tools).toEqual([]);
  });
  it("does not allow outsiders or former members to enable sharing and resets consent on leave", async () => {
    const u = await member(); const outsider = await member(); const a = await arena([u.id]);
    expect((await setToolSharing(db, outsider.id, a.id, true)).ok).toBe(false);
    await setToolSharing(db, u.id, a.id, true);
    expect((await membershipsFor(db, u.id))[0]!.shareTools).toBe(true);
    await leaveArena(db, u.id, a.id);
    expect((await setToolSharing(db, u.id, a.id, true)).ok).toBe(false);
    expect((await db.select().from(arenaMembers).where(eq(arenaMembers.arenaId, a.id)))[0]!.shareTools).toBe(false);
  });
  it("shows measured bridge tool names without granting a bridge-only streak", async () => {
    const u = await member();
    await db.insert(usageBridgeSnapshots).values({ deviceId: u.devices[0]!, snapshot: {
      source: "agentsview", schemaVersion: 6, fetchedAt: now.toISOString(), timezone: "UTC",
      pricingVersion: "test", costBasis: "source-calculated", agents: ["qwen", "empty"], rows: ["qwen", "empty"].map(agent => ({
        day: "2026-09-20", agent, model: "private-model", inputTokens: agent === "qwen" ? 100 : 0,
        outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costMicros: 0, costAvailable: false,
      })),
    } });
    expect((await arenaActivity(db, [u.id], [u.id], now)).get(u.id)).toEqual({ streakDays: 0, tools: ["qwen"] });
  });
});
