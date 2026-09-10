import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";
import { deleteAccount } from "./account.js";
import { consumeRateLimit } from "./rate-limit.js";
import {
  users,
  devices,
  identities,
  sessions,
  usageEvents,
  usageBridgeSnapshots,
  usageRepairBackups,
  arenas,
} from "./schema.js";
import { signInWithOAuth, claimHandle, createSession } from "./auth.js";

describe.skipIf(!process.env.DATABASE_URL)("privacy and concurrency", () => {
  afterAll(closeDb);
  it("purges all usage copies and sign-in credentials without deleting another member or owned club", async () => {
    const db = getDb();
    const handle = `erase_${randomUUID().slice(0, 8)}`;
    const { user } = await signInWithOAuth(db, {
      provider: "email",
      providerUid: `${handle}@example.com`,
      username: handle,
    });
    const device = `dev_${randomUUID()}`;
    const [club] = await db
      .insert(arenas)
      .values({
        name: "Preserved club",
        slug: randomUUID(),
        type: "club",
        ownerUserId: user.id,
      })
      .returning();
    try {
      await db
        .insert(devices)
        .values({ id: device, userId: user.id, publicKey: randomUUID() });
      await createSession(db, user.id);
      await db
        .insert(usageEvents)
        .values({
          userId: user.id,
          deviceId: device,
          hour: new Date(),
          agent: "codex",
          model: "test",
          dedupeKey: randomUUID(),
          sigOk: true,
        });
      await db
        .insert(usageRepairBackups)
        .values({ deviceId: device, rows: [{ inputTokens: 10 }] });
      await db
        .insert(usageBridgeSnapshots)
        .values({
          deviceId: device,
          snapshot: {
            source: "agentsview",
            schemaVersion: 6,
            timezone: "UTC",
            fetchedAt: new Date().toISOString(),
            pricingVersion: "test",
            costBasis: "source-calculated",
            agents: [],
            rows: [],
          },
        });
      expect(await deleteAccount(db, user.id, "wrong")).toBe(false);
      expect(await deleteAccount(db, user.id, handle)).toBe(true);
      for (const table of [devices, identities, sessions, usageEvents])
        expect(
          await db.select().from(table).where(eq(table.userId, user.id)),
        ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(usageRepairBackups)
          .where(eq(usageRepairBackups.deviceId, device)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(usageBridgeSnapshots)
          .where(eq(usageBridgeSnapshots.deviceId, device)),
      ).toHaveLength(0);
      expect(
        (await db.select().from(arenas).where(eq(arenas.id, club!.id)))[0]
          ?.ownerUserId,
      ).toBeNull();
    } finally {
      await db.delete(users).where(eq(users.id, user.id));
      await db.delete(arenas).where(eq(arenas.id, club!.id));
    }
  });
  it("admits only the budget under concurrent requests and resets the next window", async () => {
    const subject = randomUUID();
    const now = new Date("2026-09-10T12:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        consumeRateLimit(getDb(), "test", subject, 3, 60_000, now),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(
      (
        await consumeRateLimit(
          getDb(),
          "test",
          subject,
          3,
          60_000,
          new Date(now.getTime() + 60_000),
        )
      ).allowed,
    ).toBe(true);
  });
  it("allows exactly one concurrent case-insensitive handle claim", async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const a = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: randomUUID(),
      username: `a_${suffix}`,
    });
    const b = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: randomUUID(),
      username: `b_${suffix}`,
    });
    try {
      const results = await Promise.all([
        claimHandle(db, a.user.id, `winner_${suffix}`),
        claimHandle(db, b.user.id, `WINNER_${suffix}`),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    } finally {
      await db.delete(users).where(eq(users.id, a.user.id));
      await db.delete(users).where(eq(users.id, b.user.id));
    }
  });
});
