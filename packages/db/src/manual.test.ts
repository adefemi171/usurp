import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";
import { importManual } from "./manual.js";
import { users, usageEvents, devices } from "./schema.js";
import { dailyMetrics } from "./rating.js";

describe.skipIf(!process.env.DATABASE_URL)("manual aggregate import", () => {
  afterAll(closeDb);
  it("stores unsigned analytics once and never contributes to rating", async () => {
    const db = getDb();
    const [user] = await db
      .insert(users)
      .values({ handle: `manual_${randomUUID().slice(0, 8)}` })
      .returning();
    const now = new Date("2026-09-10T12:00:00Z");
    const bucket = {
      hour: "2026-09-10T11:00:00Z",
      agent: "claude-code",
      model: "unknown-model",
      input_tokens: 100,
      output_tokens: 100,
      cache_write_tokens: 0,
      cache_read_tokens: 0,
      calls: 1,
      sessions_started: 0,
      sessions_completed: 0,
      sessions_abandoned: 0,
      edits_applied: 0,
      edits_reverted: 0,
      commits: 0,
      cost_micros: 0,
      dedupe_key: "0".repeat(64),
    };
    try {
      expect((await importManual(db, user!.id, [bucket], now)).accepted).toBe(
        1,
      );
      expect((await importManual(db, user!.id, [bucket], now)).accepted).toBe(
        0,
      );
      const [row] = await db
        .select()
        .from(usageEvents)
        .where(eq(usageEvents.userId, user!.id));
      expect(row).toMatchObject({
        sigOk: false,
        historical: true,
        flags: expect.arrayContaining(["manual_unverified"]),
      });
      expect(
        (await db.select().from(devices).where(eq(devices.userId, user!.id)))[0]
          ?.trustTier,
      ).toBe("unverified");
      expect(
        (
          await dailyMetrics(
            db,
            new Date("2026-09-10T00:00:00Z"),
            new Date("2026-09-11T00:00:00Z"),
          )
        ).some((r) => r.userId === user!.id),
      ).toBe(false);
    } finally {
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });
});
