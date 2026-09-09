/**
 * Integration tests for arena membership.
 *
 * Two properties here are the reason these need a real database: the club cap
 * must survive concurrent redemptions of the last slot, and `#2`'s org
 * visibility default must hold across join, leave and rejoin.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import {
  CLUB_MAX_MEMBERS,
  createClub,
  defaultVisibilityFor,
  joinByInviteCode,
  leaveArena,
  membershipsFor,
  normalizeInviteCode,
  rotateInviteCode,
  setVisibility,
} from "./arenas.js";
import { signInWithOAuth } from "./auth.js";
import { joinGlobalArena, seedGlobalArena } from "./seed.js";
import { arenaMembers, arenas, users } from "./schema.js";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("normalizeInviteCode", () => {
  it("ignores case, spacing and dashes", () => {
    expect(normalizeInviteCode(" a6bp5-s9tkj ")).toBe("A6BP5S9TKJ");
    expect(normalizeInviteCode("A6BP5 S9TKJ")).toBe("A6BP5S9TKJ");
  });
});

describe("defaultVisibilityFor", () => {
  it("hides org members and shows everyone else — `#2`'s invariant", () => {
    expect(defaultVisibilityFor("org")).toBe("hidden");
    expect(defaultVisibilityFor("club")).toBe("public");
    expect(defaultVisibilityFor("global")).toBe("public");
  });
});

describe.skipIf(!hasDb)("arenas (database)", () => {
  const db = hasDb ? getDb() : (undefined as never);
  const users_: string[] = [];
  const arenas_: string[] = [];

  afterEach(async () => {
    for (const id of arenas_.splice(0)) {
      await db.delete(arenas).where(eq(arenas.id, id));
    }
    for (const id of users_.splice(0)) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  async function newUser() {
    const { user } = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: `t_${Math.random().toString(36).slice(2, 12)}`,
      username: `t${Math.random().toString(36).slice(2, 10)}`,
    });
    users_.push(user.id);
    return user;
  }

  async function newClub(ownerId: string, name = "Test Club") {
    const result = await createClub(db, ownerId, name);
    if (!result.ok) throw new Error(`createClub failed: ${result.failure}`);
    arenas_.push(result.arena.id);
    return result;
  }

  describe("createClub", () => {
    it("creates a capped club with an invite code and enrols the owner", async () => {
      const owner = await newUser();
      const { arena, member } = await newClub(owner.id);

      expect(arena.type).toBe("club");
      expect(arena.maxMembers).toBe(CLUB_MAX_MEMBERS);
      expect(arena.inviteCode).toMatch(/^[0-9A-Z]{10}$/);
      expect(arena.ownerUserId).toBe(owner.id);
      expect(member.visibility).toBe("public");
    });

    it("gives two clubs of the same name distinct slugs", async () => {
      const owner = await newUser();
      const a = await newClub(owner.id, "Backend");
      const b = await newClub(owner.id, "Backend");
      expect(a.arena.slug).not.toBe(b.arena.slug);
    });

    it("rejects a name outside the length bounds", async () => {
      const owner = await newUser();
      expect(await createClub(db, owner.id, "x")).toEqual({
        ok: false,
        failure: "invalid_name",
      });
      expect(await createClub(db, owner.id, "y".repeat(49))).toEqual({
        ok: false,
        failure: "invalid_name",
      });
    });
  });

  describe("joinByInviteCode", () => {
    it("joins by code, however it was typed", async () => {
      const owner = await newUser();
      const joiner = await newUser();
      const { arena } = await newClub(owner.id);

      const messy = arena.inviteCode!.toLowerCase().replace(/^(.{3})/, "$1-");
      const result = await joinByInviteCode(db, joiner.id, messy);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.arena.id).toBe(arena.id);
    });

    it("refuses an unknown code", async () => {
      const joiner = await newUser();
      expect(await joinByInviteCode(db, joiner.id, "NOSUCHCODE")).toEqual({
        ok: false,
        failure: "invalid_code",
      });
    });

    it("refuses an empty code without hitting the database", async () => {
      const joiner = await newUser();
      expect(await joinByInviteCode(db, joiner.id, "   ")).toEqual({
        ok: false,
        failure: "invalid_code",
      });
    });

    it("refuses a second join", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);
      expect(await joinByInviteCode(db, owner.id, arena.inviteCode!)).toEqual({
        ok: false,
        failure: "already_member",
      });
    });

    it("enforces the member cap", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);

      // Fill to the cap directly — creating 49 users through OAuth would make
      // this test about signup throughput rather than the cap.
      await db.execute(sql`
        insert into ${arenaMembers} (arena_id, user_id, visibility, status)
        select ${arena.id}, gen_random_uuid(), 'public', 'active'
        from generate_series(1, ${CLUB_MAX_MEMBERS - 1})
      `).catch(async () => {
        // The user_id FK forbids synthetic ids; fall back to real users.
        for (let i = 0; i < CLUB_MAX_MEMBERS - 1; i++) {
          const u = await newUser();
          await db.insert(arenaMembers).values({ arenaId: arena.id, userId: u.id });
        }
      });

      const late = await newUser();
      expect(await joinByInviteCode(db, late.id, arena.inviteCode!)).toEqual({
        ok: false,
        failure: "club_full",
      });
    });

    it("admits only one of two racing joins for the last slot", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);
      // Cap this club at 2 so exactly one slot remains after the owner.
      await db.update(arenas).set({ maxMembers: 2 }).where(eq(arenas.id, arena.id));

      const a = await newUser();
      const b = await newUser();

      const results = await Promise.all([
        joinByInviteCode(db, a.id, arena.inviteCode!),
        joinByInviteCode(db, b.id, arena.inviteCode!),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.failure === "club_full")).toHaveLength(1);
    });

    it("frees a slot when someone leaves", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);
      await db.update(arenas).set({ maxMembers: 2 }).where(eq(arenas.id, arena.id));

      const a = await newUser();
      const b = await newUser();
      expect((await joinByInviteCode(db, a.id, arena.inviteCode!)).ok).toBe(true);
      expect((await joinByInviteCode(db, b.id, arena.inviteCode!)).ok).toBe(false);

      await leaveArena(db, a.id, arena.id);
      expect((await joinByInviteCode(db, b.id, arena.inviteCode!)).ok).toBe(true);
    });
  });

  describe("`#2` org rules", () => {
    async function newOrg() {
      const [arena] = await db
        .insert(arenas)
        .values({
          type: "org",
          name: "Test Org",
          slug: `o-${Math.random().toString(36).slice(2, 10)}`,
          inviteCode: `ORG${Math.random().toString(36).slice(2, 9).toUpperCase()}`,
        })
        .returning();
      arenas_.push(arena!.id);
      return arena!;
    }

    it("starts an org membership hidden, not public", async () => {
      const org = await newOrg();
      const joiner = await newUser();

      const result = await joinByInviteCode(db, joiner.id, org.inviteCode!);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.member.visibility).toBe("hidden");
    });

    it("allows at most one org", async () => {
      const first = await newOrg();
      const second = await newOrg();
      const joiner = await newUser();

      expect((await joinByInviteCode(db, joiner.id, first.inviteCode!)).ok).toBe(true);
      expect(await joinByInviteCode(db, joiner.id, second.inviteCode!)).toEqual({
        ok: false,
        failure: "already_in_org",
      });
    });

    it("resets to hidden on rejoin, so leaving cannot quietly re-expose you", async () => {
      const org = await newOrg();
      const joiner = await newUser();

      await joinByInviteCode(db, joiner.id, org.inviteCode!);
      await setVisibility(db, joiner.id, org.id, "public");
      await leaveArena(db, joiner.id, org.id);

      const rejoined = await joinByInviteCode(db, joiner.id, org.inviteCode!);
      expect(rejoined.ok).toBe(true);
      if (rejoined.ok) {
        expect(rejoined.rejoined).toBe(true);
        expect(rejoined.member.visibility).toBe("hidden");
      }
    });

    it("lets someone rejoin an org they left, since the slot was theirs", async () => {
      const org = await newOrg();
      const joiner = await newUser();
      await joinByInviteCode(db, joiner.id, org.inviteCode!);
      await leaveArena(db, joiner.id, org.id);
      expect((await joinByInviteCode(db, joiner.id, org.inviteCode!)).ok).toBe(true);
    });
  });

  describe("setVisibility / leaveArena", () => {
    it("sets each visibility mode", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);

      for (const v of ["anonymous", "hidden", "public"] as const) {
        const result = await setVisibility(db, owner.id, arena.id, v);
        expect(result.ok && result.member.visibility).toBe(v);
      }
    });

    it("refuses for a non-member", async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const { arena } = await newClub(owner.id);

      expect(await setVisibility(db, stranger.id, arena.id, "public")).toEqual({
        ok: false,
        failure: "not_a_member",
      });
      expect(await leaveArena(db, stranger.id, arena.id)).toEqual({
        ok: false,
        failure: "not_a_member",
      });
    });

    it("leaves without deleting the row, and hides the member", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);

      expect((await leaveArena(db, owner.id, arena.id)).ok).toBe(true);

      // `#6.2` — history stays intact, so the row survives as `left`.
      const rows = await db
        .select()
        .from(arenaMembers)
        .where(eq(arenaMembers.arenaId, arena.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "left", visibility: "hidden" });
    });
  });

  describe("global arena opt-in / opt-out (`#10.2`)", () => {
    it("lets a user leave global and rejoin", async () => {
      const user = await newUser();
      await joinGlobalArena(db, user.id);
      const globalArena = await seedGlobalArena(db);

      expect((await membershipsFor(db, user.id)).map((m) => m.arena.slug)).toContain("global");

      await leaveArena(db, user.id, globalArena.id);
      expect((await membershipsFor(db, user.id)).map((m) => m.arena.slug)).not.toContain(
        "global",
      );

      // The regression: with `onConflictDoNothing` this silently changed
      // nothing and the membership stayed `left` forever.
      await joinGlobalArena(db, user.id);
      const after = await membershipsFor(db, user.id);
      expect(after.map((m) => m.arena.slug)).toContain("global");
      expect(after.find((m) => m.arena.slug === "global")!.status).toBe("active");
    });

    it("does not un-hide a current member who opts in again", async () => {
      const user = await newUser();
      await joinGlobalArena(db, user.id);
      const globalArena = await seedGlobalArena(db);

      await setVisibility(db, user.id, globalArena.id, "hidden");
      // A second opt-in must not quietly reset a deliberate choice.
      await joinGlobalArena(db, user.id);

      const membership = (await membershipsFor(db, user.id)).find(
        (m) => m.arena.slug === "global",
      );
      expect(membership!.visibility).toBe("hidden");
    });

    it("is idempotent for a fresh member", async () => {
      const user = await newUser();
      await joinGlobalArena(db, user.id);
      await joinGlobalArena(db, user.id);

      const globals = (await membershipsFor(db, user.id)).filter(
        (m) => m.arena.slug === "global",
      );
      expect(globals).toHaveLength(1);
    });
  });

  describe("membershipsFor", () => {
    it("lists active arenas and hides the invite code from non-owners", async () => {
      const owner = await newUser();
      const joiner = await newUser();
      const { arena } = await newClub(owner.id);
      await joinByInviteCode(db, joiner.id, arena.inviteCode!);

      const ownerView = await membershipsFor(db, owner.id);
      const joinerView = await membershipsFor(db, joiner.id);

      expect(ownerView[0]!.inviteCode).toBe(arena.inviteCode);
      // Any member could otherwise invite anyone; the owner controls entry.
      expect(joinerView[0]!.inviteCode).toBeNull();
      expect(joinerView[0]!.memberCount).toBe(2);
    });

    it("omits arenas the user has left", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);
      await leaveArena(db, owner.id, arena.id);
      expect(await membershipsFor(db, owner.id)).toEqual([]);
    });
  });

  describe("rotateInviteCode", () => {
    it("issues a new code and invalidates the old one", async () => {
      const owner = await newUser();
      const { arena } = await newClub(owner.id);
      const old = arena.inviteCode!;

      const fresh = await rotateInviteCode(db, owner.id, arena.id);
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(old);

      const joiner = await newUser();
      expect(await joinByInviteCode(db, joiner.id, old)).toEqual({
        ok: false,
        failure: "invalid_code",
      });
      expect((await joinByInviteCode(db, joiner.id, fresh!)).ok).toBe(true);
    });

    it("refuses a non-owner", async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const { arena } = await newClub(owner.id);
      expect(await rotateInviteCode(db, stranger.id, arena.id)).toBeUndefined();
    });
  });
});
