import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";
import {
  users,
  devices,
  usageEvents,
  usageReviews,
  arenas,
  arenaMembers,
  dailyScores,
  standings,
} from "./schema.js";
import { reviewSuspiciousUsage, setUsageReview } from "./review.js";
import { recomputeStandings, ratingBoard } from "./rating.js";
import { ensureCurrentSeason, startOfUtcDay } from "./seasons.js";

describe.skipIf(!process.env.DATABASE_URL)("usage review", () => {
  afterAll(closeDb);
  it("does not punish pricing gaps; freezes repeated commit anomalies and supports audited clearance", async () => {
    const db = getDb(),
      now = new Date("2026-09-10T12:00:00Z");
    const [user] = await db
      .insert(users)
      .values({ handle: `review_${randomUUID().slice(0, 8)}` })
      .returning();
    const deviceId = `review_${user!.id}`;
    try {
      await db
        .insert(devices)
        .values({ id: deviceId, userId: user!.id, publicKey: deviceId });
      await db
        .insert(usageEvents)
        .values(
          [1, 2, 3].map((h) => ({
            deviceId,
            userId: user!.id,
            hour: new Date(+now - h * 3600_000),
            agent: "test",
            model: "test",
            dedupeKey: `${deviceId}_${h}`,
            sigOk: true,
            flags: ["unknown_model", "cost_mismatch"],
          })),
        );
      expect(await reviewSuspiciousUsage(db, user!.id, now)).toBe(false);
      await db
        .update(usageEvents)
        .set({ flags: ["commits_per_hour_exceeded"] })
        .where(eq(usageEvents.userId, user!.id));
      expect(await reviewSuspiciousUsage(db, user!.id, now)).toBe(true);
      expect(await reviewSuspiciousUsage(db, user!.id, now)).toBe(false);
      expect(
        await db
          .select()
          .from(usageReviews)
          .where(eq(usageReviews.userId, user!.id)),
      ).toHaveLength(1);
      expect(
        await setUsageReview(
          db,
          user!.id,
          "clear",
          "Confirmed legitimate bulk migration",
          "test-operator",
          new Date(+now + 1000),
        ),
      ).toBe(true);
      expect(
        await reviewSuspiciousUsage(db, user!.id, new Date(+now + 2000)),
      ).toBe(false);
    } finally {
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });
  it("keeps analytics but freezes rating accrual and removes title eligibility until reviewed", async () => {
    const db = getDb(),
      now = new Date("2026-09-10T12:00:00Z");
    const people = await db
      .insert(users)
      .values(
        [1, 2, 3].map(() => ({ handle: `freeze_${randomUUID().slice(0, 8)}` })),
      )
      .returning();
    const [arena] = await db
      .insert(arenas)
      .values({
        type: "club",
        name: "Review test",
        slug: `review-${randomUUID()}`,
      })
      .returning();
    try {
      for (const [i, user] of people.entries()) {
        await db
          .insert(arenaMembers)
          .values({
            arenaId: arena!.id,
            userId: user.id,
            visibility: "public",
          });
        await db
          .insert(dailyScores)
          .values({
            userId: user.id,
            day: startOfUtcDay(now),
            volumePts: 1,
            efficiencyMultBp: 10000,
            streakMultBp: 10000,
            points: (3 - i) * 100,
          });
      }
      const season = await ensureCurrentSeason(db, arena!.id, now);
      await recomputeStandings(db, arena!.id, season, now);
      await setUsageReview(
        db,
        people[0]!.id,
        "shadow_frozen",
        "Manual review requested",
        "test-operator",
        now,
      );
      await db
        .update(dailyScores)
        .set({ points: 9999 })
        .where(eq(dailyScores.userId, people[0]!.id));
      const result = await recomputeStandings(
        db,
        arena!.id,
        season,
        new Date(+now + 1000),
      );
      expect(result.rows.find((r) => r.userId === people[0]!.id)).toMatchObject(
        { points: 300, title: undefined },
      );
      expect(
        (await ratingBoard(db, arena!.slug, { now }))?.rows.find(
          (r) => r.userId === people[0]!.id,
        )?.title,
      ).toBeUndefined();
      await setUsageReview(
        db,
        people[0]!.id,
        "clear",
        "Legitimate usage confirmed",
        "test-operator",
        new Date(+now + 2000),
      );
      await recomputeStandings(db, arena!.id, season, new Date(+now + 3000));
      expect(
        (
          await db
            .select()
            .from(standings)
            .where(
              and(
                eq(standings.seasonId, season.id),
                eq(standings.userId, people[0]!.id),
              ),
            )
        )[0]?.points,
      ).toBe(9999);
    } finally {
      await db.delete(arenas).where(eq(arenas.id, arena!.id));
      await db.delete(users).where(
        inArray(
          users.id,
          people.map((u) => u.id),
        ),
      );
    }
  });
});
