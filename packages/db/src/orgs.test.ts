import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";
import {
  createOrg,
  verifyOrg,
  renewOrgChallenge,
  joinOrg,
  orgAggregate,
  normalizeOrgDomain,
} from "./orgs.js";
import { leaveArena, setVisibility } from "./arenas.js";
import { signInWithOAuth } from "./auth.js";
import {
  users,
  arenas,
  arenaMembers,
  identities,
  devices,
  usageEvents,
  usageBridgeSnapshots,
} from "./schema.js";

describe("organization domain validation", () => {
  it("rejects consumer email domains and malformed DNS names", () => {
    for (const domain of [
      "gmail.com",
      "localhost",
      "127.0.0.1",
      "https://example.com",
      "example.com/path",
      "a..example.com",
    ])
      expect(() => normalizeOrgDomain(domain)).toThrow();
    expect(normalizeOrgDomain(" Example.COM ")).toBe("example.com");
  });
});
describe.skipIf(!process.env.DATABASE_URL)(
  "organization consent and privacy",
  () => {
    afterAll(closeDb);
    it("requires actual DNS proof, verified work email, and explicit hidden-by-default membership", async () => {
      const db = getDb(),
        uid = randomUUID();
      const { user } = await signInWithOAuth(db, {
        provider: "dev",
        providerUid: uid,
        username: `org_${uid.slice(0, 8)}`,
        email: "person@example.com",
      });
      const org = await createOrg(
        db,
        user.id,
        "Test organization",
        "example.com",
      );
      try {
        expect(
          await verifyOrg(db, user.id, org.arena.id, new Date(), async () => [
            ["unrelated"],
          ]),
        ).toBe(false);
        expect(
          await verifyOrg(db, user.id, org.arena.id, new Date(), async () => [
            [org.value],
          ]),
        ).toBe(true);
        await expect(joinOrg(db, user.id, org.arena.id, false)).rejects.toThrow(
          "consent_required",
        );
        await expect(joinOrg(db, user.id, org.arena.id, true)).rejects.toThrow(
          "verified_work_email_required",
        );
        await db
          .insert(identities)
          .values({
            userId: user.id,
            provider: "email",
            providerUid: `${uid}@example.com`,
          });
        await joinOrg(db, user.id, org.arena.id, true);
        const [member] = await db
          .select()
          .from(arenaMembers)
          .where(eq(arenaMembers.arenaId, org.arena.id));
        expect(member?.visibility).toBe("hidden");
        await setVisibility(db, user.id, org.arena.id, "public");
        await joinOrg(db, user.id, org.arena.id, true);
        expect(
          (
            await db
              .select()
              .from(arenaMembers)
              .where(eq(arenaMembers.arenaId, org.arena.id))
          )[0]?.visibility,
        ).toBe("public");
        await leaveArena(db, user.id, org.arena.id);
        await joinOrg(db, user.id, org.arena.id, true);
        expect(
          (
            await db
              .select()
              .from(arenaMembers)
              .where(eq(arenaMembers.arenaId, org.arena.id))
          )[0]?.visibility,
        ).toBe("hidden");
        expect(await orgAggregate(db, user.id, org.arena.id)).toMatchObject({
          suppressed: true,
          minimumContributors: 5,
        });
        expect(await orgAggregate(db, randomUUID(), org.arena.id)).toBeNull();
        const another = await createOrg(
          db,
          user.id,
          "Another organization",
          "another.example.com",
        );
        try {
          await verifyOrg(
            db,
            user.id,
            another.arena.id,
            new Date(),
            async () => [[another.value]],
          );
          await db
            .insert(identities)
            .values({
              userId: user.id,
              provider: "email",
              providerUid: `${uid}@another.example.com`,
            });
          await expect(
            joinOrg(db, user.id, another.arena.id, true),
          ).rejects.toThrow("already_in_org");
        } finally {
          await db.delete(arenas).where(eq(arenas.id, another.arena.id));
        }
      } finally {
        await db.delete(arenas).where(eq(arenas.id, org.arena.id));
        await db.delete(users).where(eq(users.id, user.id));
      }
    });
    it("renews lost challenges and rejects the old DNS value", async () => {
      const db = getDb();
      const [user] = await db
        .insert(users)
        .values({ handle: `dns_${randomUUID().slice(0, 8)}` })
        .returning();
      const org = await createOrg(
        db,
        user!.id,
        "DNS test",
        `${randomUUID()}.example.com`,
      );
      try {
        await expect(
          renewOrgChallenge(db, randomUUID(), org.arena.id),
        ).rejects.toThrow("not_owner");
        const next = await renewOrgChallenge(db, user!.id, org.arena.id);
        expect(
          await verifyOrg(db, user!.id, org.arena.id, new Date(), async () => [
            [org.value],
          ]),
        ).toBe(false);
        expect(
          await verifyOrg(db, user!.id, org.arena.id, new Date(), async () => [
            [next.value],
          ]),
        ).toBe(true);
        await expect(
          renewOrgChallenge(db, user!.id, org.arena.id),
        ).rejects.toThrow("not_pending");
      } finally {
        await db.delete(arenas).where(eq(arenas.id, org.arena.id));
        await db.delete(users).where(eq(users.id, user!.id));
      }
    });
    it("returns only a weekly total at five contributors and excludes pre-consent activity", async () => {
      const db = getDb(),
        created: string[] = [];
      const [owner] = await db
        .insert(users)
        .values({ handle: `agg_${randomUUID().slice(0, 8)}` })
        .returning();
      created.push(owner!.id);
      const org = await createOrg(
        db,
        owner!.id,
        "Aggregate test",
        `${randomUUID()}.example.com`,
      );
      try {
        await verifyOrg(db, owner!.id, org.arena.id, new Date(), async () => [
          [org.value],
        ]);
        for (let i = 0; i < 5; i++) {
          const [u] = await db
            .insert(users)
            .values({ handle: `agg_${randomUUID().slice(0, 8)}` })
            .returning();
          created.push(u!.id);
          await db
            .insert(arenaMembers)
            .values({
              arenaId: org.arena.id,
              userId: u!.id,
              visibility: "hidden",
              joinedAt: new Date("2026-08-31T00:00:00Z"),
            });
          const deviceId = `agg_${u!.id}`;
          await db
            .insert(devices)
            .values({ id: deviceId, userId: u!.id, publicKey: deviceId });
          await db
            .insert(usageEvents)
            .values({
              userId: u!.id,
              deviceId,
              agent: "test",
              model: "test",
              hour: new Date("2026-09-01T00:00:00Z"),
              inputTokens: 10,
              outputTokens: 2,
              cacheWriteTokens: 3,
              costMicros: 100,
              dedupeKey: deviceId,
              sigOk: true,
            });
        }
        const now = new Date("2026-09-10T12:00:00Z");
        const report = await orgAggregate(db, owner!.id, org.arena.id, now);
        expect(report).toMatchObject({
          suppressed: false,
          tokens: "75",
          costMicros: "500",
        });
        expect(JSON.stringify(report)).not.toContain(created[1]);
        await db
          .insert(usageBridgeSnapshots)
          .values({
            deviceId: `agg_${created[1]}`,
            snapshot: {
              source: "agentsview",
              schemaVersion: 6,
              timezone: "UTC",
              fetchedAt: now.toISOString(),
              pricingVersion: "historical",
              costBasis: "source-calculated",
              agents: ["test"],
              rows: [
                {
                  day: "2026-09-01",
                  agent: "test",
                  model: "test",
                  inputTokens: 20,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  costMicros: 250,
                  costAvailable: true,
                },
              ],
            },
          });
        expect(
          await orgAggregate(db, owner!.id, org.arena.id, now),
        ).toMatchObject({
          tokens: "80",
          costMicros: "650",
          costComplete: true,
        });
        await db
          .update(arenaMembers)
          .set({ joinedAt: new Date("2026-09-02T00:00:00Z") })
          .where(
            and(
              eq(arenaMembers.arenaId, org.arena.id),
              eq(arenaMembers.userId, created[1]!),
            ),
          );
        expect(
          await orgAggregate(db, owner!.id, org.arena.id, now),
        ).toMatchObject({ suppressed: true });
      } finally {
        await db.delete(arenas).where(eq(arenas.id, org.arena.id));
        await db.delete(users).where(inArray(users.id, created));
      }
    });
  },
);
