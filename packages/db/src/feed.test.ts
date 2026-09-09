/**
 * Integration tests for the feed and the Longest Reign hall.
 *
 * The bulk of these are privacy tests. A feed entry is a sentence naming two
 * people, so it is the most likely place for `#2`'s visibility promises to
 * leak — and it would leak *retroactively*, exposing someone who has since
 * gone anonymous.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import { arenaMembers, arenas, dailyScores, users } from "./schema.js";
import { arenaFeed, currentSovereign, longestReigns } from "./feed.js";
import { recomputeStandings } from "./rating.js";
import { ensureCurrentSeason, startOfUtcDay } from "./seasons.js";
import { setVisibility, leaveArena } from "./arenas.js";
import { signInWithOAuth } from "./auth.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-09-20T12:00:00.000Z");

describe.skipIf(!hasDb)("feed (database)", () => {
  const db = hasDb ? getDb() : (undefined as never);
  const createdUsers: string[] = [];
  const createdArenas: string[] = [];

  afterEach(async () => {
    for (const id of createdArenas.splice(0)) {
      await db.delete(arenas).where(eq(arenas.id, id));
    }
    for (const id of createdUsers.splice(0)) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  async function newUser() {
    const { user } = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: `fd_${Math.random().toString(36).slice(2, 12)}`,
      username: `fd${Math.random().toString(36).slice(2, 10)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  async function newArena(memberIds: string[]) {
    const [arena] = await db
      .insert(arenas)
      .values({
        type: "club",
        name: "Feed Test",
        slug: `fd-${Math.random().toString(36).slice(2, 10)}`,
        maxMembers: 50,
      })
      .returning();
    createdArenas.push(arena!.id);
    for (const userId of memberIds) {
      await db.insert(arenaMembers).values({ arenaId: arena!.id, userId, visibility: "public" });
    }
    return arena!;
  }

  async function setDay(userId: string, day: Date, points: number) {
    await db
      .insert(dailyScores)
      .values({
        userId,
        day: startOfUtcDay(day),
        volumePts: points,
        efficiencyMultBp: 10_000,
        streakMultBp: 10_000,
        points,
      })
      .onConflictDoUpdate({
        target: [dailyScores.userId, dailyScores.day],
        set: { points },
      });
  }

  /** Build an arena where `b` has usurped `a`. */
  async function withUsurping() {
    const [a, b, c] = [await newUser(), await newUser(), await newUser()];
    const arena = await newArena([a.id, b.id, c.id]);
    const season = await ensureCurrentSeason(db, arena.id, NOW);

    await setDay(a.id, NOW, 500);
    await recomputeStandings(db, arena.id, season, NOW);

    await setDay(b.id, NOW, 900);
    await recomputeStandings(db, arena.id, season, new Date(NOW.getTime() + 60_000));

    return { arena, a, b, c };
  }

  describe("arenaFeed", () => {
    it("renders crowned and usurped in the active voice", async () => {
      const { arena, a, b } = await withUsurping();
      const feed = await arenaFeed(db, arena.slug);

      expect(feed!.entries.map((e) => e.type)).toEqual(["usurped", "crowned"]);
      expect(feed!.entries[0]!.text).toBe(
        `${b.handle} usurped the Throne from ${a.handle}.`,
      );
      expect(feed!.entries[1]!.text).toBe(`${a.handle} is the first Sovereign of Feed Test.`);
    });

    it("uses the pseudonym for an anonymous actor", async () => {
      const { arena, b } = await withUsurping();
      await setVisibility(db, b.id, arena.id, "anonymous");

      const feed = await arenaFeed(db, arena.slug);
      const usurping = feed!.entries.find((e) => e.type === "usurped")!;

      expect(usurping.text).not.toContain(b.handle);
      expect(usurping.text).toMatch(/^Anonymous /);
      expect(usurping.actor!.handle).toBeNull();
      expect(usurping.actor!.pseudonym).toMatch(/^Anonymous /);
    });

    it("uses the pseudonym for an anonymous target too", async () => {
      const { arena, a } = await withUsurping();
      await setVisibility(db, a.id, arena.id, "anonymous");

      const feed = await arenaFeed(db, arena.slug);
      const usurping = feed!.entries.find((e) => e.type === "usurped")!;

      expect(usurping.text).not.toContain(a.handle);
      expect(usurping.text).toContain("Anonymous ");
    });

    it("drops entries naming a hidden member entirely", async () => {
      const { arena, b } = await withUsurping();
      await setVisibility(db, b.id, arena.id, "hidden");

      const feed = await arenaFeed(db, arena.slug);

      // Half-anonymising a two-person sentence invites guessing, so the whole
      // entry goes.
      expect(feed!.entries.map((e) => e.type)).toEqual(["crowned"]);
      expect(JSON.stringify(feed!.entries)).not.toContain(b.handle);
    });

    it("hides retroactively — a member going anonymous unnames their history", async () => {
      const { arena, b } = await withUsurping();

      const before = await arenaFeed(db, arena.slug);
      expect(before!.entries[0]!.text).toContain(b.handle);

      await setVisibility(db, b.id, arena.id, "anonymous");

      const after = await arenaFeed(db, arena.slug);
      // The event row is unchanged (`#6.2` append-only); only the rendering
      // follows their current choice.
      expect(after!.entries[0]!.text).not.toContain(b.handle);
    });

    it("drops entries for a member who left", async () => {
      const { arena, b } = await withUsurping();
      await leaveArena(db, b.id, arena.id);

      const feed = await arenaFeed(db, arena.slug);
      expect(JSON.stringify(feed!.entries)).not.toContain(b.handle);
    });

    it("returns newest first and respects the limit", async () => {
      const { arena } = await withUsurping();
      const feed = await arenaFeed(db, arena.slug, { limit: 1 });

      expect(feed!.entries).toHaveLength(1);
      expect(feed!.entries[0]!.type).toBe("usurped");
    });

    it("pages with the before cursor", async () => {
      const { arena } = await withUsurping();
      const first = await arenaFeed(db, arena.slug, { limit: 1 });
      const second = await arenaFeed(db, arena.slug, {
        limit: 1,
        before: first!.entries[0]!.createdAt,
      });

      expect(second!.entries[0]!.type).toBe("crowned");
    });

    it("returns undefined for an unknown arena", async () => {
      expect(await arenaFeed(db, "no-such-arena")).toBeUndefined();
    });

    it("returns an empty feed for an arena with no events", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);
      const feed = await arenaFeed(db, arena.slug);
      expect(feed!.entries).toEqual([]);
    });
  });

  describe("longestReigns", () => {
    it("ranks by duration and marks the open reign", async () => {
      const { arena, a, b } = await withUsurping();
      const records = await longestReigns(db, { arenaSlug: arena.slug, now: NOW });

      expect(records).toHaveLength(2);
      // `a`'s reign is closed; `b`'s is open and still growing.
      const open = records.find((r) => r.open)!;
      const closed = records.find((r) => !r.open)!;

      expect(open.holder.handle).toBe(b.handle);
      expect(closed.holder.handle).toBe(a.handle);
      // `#5.1` — being dethroned still leaves a record, including who did it.
      expect(closed.endedBy!.handle).toBe(b.handle);
    });

    it("reports peak points, not current points", async () => {
      const { arena, a } = await withUsurping();
      const records = await longestReigns(db, { arenaSlug: arena.slug, now: NOW });
      const closed = records.find((r) => r.holder.handle === a.handle)!;
      expect(closed.peakPoints).toBe(500);
    });

    it("omits a hidden holder", async () => {
      const { arena, b } = await withUsurping();
      await setVisibility(db, b.id, arena.id, "hidden");

      const records = await longestReigns(db, { arenaSlug: arena.slug, now: NOW });
      expect(records.map((r) => r.holder.handle)).not.toContain(b.handle);
    });

    it("pseudonymises an anonymous holder rather than dropping the record", async () => {
      const { arena, b } = await withUsurping();
      await setVisibility(db, b.id, arena.id, "anonymous");

      const records = await longestReigns(db, { arenaSlug: arena.slug, now: NOW });
      const theirs = records.find((r) => r.holder.pseudonym !== null)!;

      // The reign is the achievement being honoured; the name is optional.
      expect(theirs).toBeDefined();
      expect(theirs.holder.handle).toBeNull();
    });

    it("keeps a record whose ender has gone hidden", async () => {
      const { arena, a, b } = await withUsurping();
      await setVisibility(db, b.id, arena.id, "hidden");

      const records = await longestReigns(db, { arenaSlug: arena.slug, now: NOW });
      const closed = records.find((r) => r.holder.handle === a.handle)!;

      expect(closed).toBeDefined();
      // Their own record survives; only the ender's name is withheld.
      expect(closed.endedBy).toBeNull();
    });

    it("measures an open reign to now", async () => {
      const { arena } = await withUsurping();
      const later = new Date(NOW.getTime() + 5 * 86_400_000);
      const records = await longestReigns(db, { arenaSlug: arena.slug, now: later });
      const open = records.find((r) => r.open)!;
      expect(open.days).toBeGreaterThanOrEqual(4);
    });

    it("reads across arenas by default", async () => {
      const first = await withUsurping();
      const second = await withUsurping();
      const records = await longestReigns(db, { now: NOW });
      const slugs = records.map((r) => r.arena.slug);

      expect(slugs).toContain(first.arena.slug);
      expect(slugs).toContain(second.arena.slug);
    });
  });

  describe("currentSovereign", () => {
    it("returns the open reign's holder", async () => {
      const { arena, b } = await withUsurping();
      const sovereign = await currentSovereign(db, arena.id);
      expect(sovereign!.userId).toBe(b.id);
    });

    it("returns undefined when nobody holds the Throne", async () => {
      const a = await newUser();
      const arena = await newArena([a.id]);
      expect(await currentSovereign(db, arena.id)).toBeUndefined();
    });
  });
});
