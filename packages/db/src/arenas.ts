/**
 * Arena membership — `SPEC.md#2`, `#9` M1.
 *
 * One entity, three types. The rules this file enforces:
 *
 *   - a user is in **at most one** `org`, zero-or-one `global`, and many `club`s
 *   - a club caps at 50 members
 *   - **org membership defaults to `hidden`**, and that default is set here
 *     rather than by a column default, because it depends on the arena's type
 *
 * That last one is the product invariant, not a setting: `#2` says org arenas
 * are opt-in per member and admins see aggregates only. A column default of
 * `public` shared by all three types would silently opt every org member into
 * being individually ranked by their employer.
 */

import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  arenaMembers,
  arenas,
  type Arena,
  type ArenaMember,
} from "./schema.js";

/** `#2` — clubs are invite-only and capped. */
export const CLUB_MAX_MEMBERS = 50;

/** Invite codes are read aloud and retyped; drop the confusable characters. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;

export const NAME_MIN = 2;
export const NAME_MAX = 48;

function randomCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte & 31];
  return out;
}

/** Accept an invite code however it was typed. */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Slug for a club.
 *
 * Prefixed `c-` and suffixed with entropy rather than derived purely from the
 * name: two clubs may legitimately be called "Backend", and a slug collision
 * would make one of them unreachable.
 */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return `c-${base || "club"}-${randomCode().slice(0, 6).toLowerCase()}`;
}

/**
 * The visibility a fresh membership gets, by arena type.
 *
 * `#2`'s hard invariant lives here.
 */
export function defaultVisibilityFor(type: Arena["type"]): "public" | "hidden" {
  return type === "org" ? "hidden" : "public";
}

export type CreateClubFailure = "invalid_name" | "too_many_clubs";

/** How many clubs one user may own, to keep code-minting from being a spam vector. */
export const MAX_OWNED_CLUBS = 20;

export type CreateClubResult =
  | { ok: true; arena: Arena; member: ArenaMember }
  | { ok: false; failure: CreateClubFailure };

export async function createClub(
  db: Db,
  ownerUserId: string,
  name: string,
): Promise<CreateClubResult> {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
    return { ok: false, failure: "invalid_name" };
  }

  const [owned] = await db
    .select({ n: count() })
    .from(arenas)
    .where(and(eq(arenas.ownerUserId, ownerUserId), eq(arenas.type, "club")));

  if (Number(owned?.n ?? 0) >= MAX_OWNED_CLUBS) {
    return { ok: false, failure: "too_many_clubs" };
  }

  return db.transaction(async (tx) => {
    // Retry on the vanishingly unlikely slug or code collision rather than
    // failing the user's request.
    let arena: Arena | undefined;
    for (let attempt = 0; attempt < 5 && !arena; attempt++) {
      try {
        const [created] = await tx
          .insert(arenas)
          .values({
            type: "club",
            name: trimmed,
            slug: slugify(trimmed),
            inviteCode: randomCode(),
            ownerUserId,
            maxMembers: CLUB_MAX_MEMBERS,
          })
          .returning();
        arena = created;
      } catch (err) {
        if (attempt === 4) throw err;
      }
    }

    const [member] = await tx
      .insert(arenaMembers)
      .values({
        arenaId: arena!.id,
        userId: ownerUserId,
        visibility: defaultVisibilityFor("club"),
      })
      .returning();

    return { ok: true as const, arena: arena!, member: member! };
  });
}

export type JoinFailure =
  | "invalid_code"
  | "club_full"
  | "already_member"
  | "already_in_org";

export type JoinResult =
  | { ok: true; arena: Arena; member: ArenaMember; rejoined: boolean }
  | { ok: false; failure: JoinFailure };

/**
 * Join an arena by invite code.
 *
 * The whole thing runs in one transaction with the arena row locked, because
 * the 50-member cap is otherwise trivially exceeded: two people redeeming the
 * 50th slot concurrently would both count 49 and both insert.
 */
export async function joinByInviteCode(
  db: Db,
  userId: string,
  code: string,
): Promise<JoinResult> {
  const normalized = normalizeInviteCode(code);
  if (normalized.length === 0) return { ok: false, failure: "invalid_code" };

  return db.transaction(async (tx) => {
    const [arena] = await tx
      .select()
      .from(arenas)
      .where(eq(arenas.inviteCode, normalized))
      .limit(1)
      .for("update");

    if (!arena) return { ok: false as const, failure: "invalid_code" as const };

    // Organization admission requires DNS proof, a verified work email and
    // explicit aggregate consent through joinOrg. Legacy codes cannot bypass it.
    if (arena.type === "org") {
      return { ok: false as const, failure: "invalid_code" as const };
    }

    const [existing] = await tx
      .select()
      .from(arenaMembers)
      .where(
        and(
          eq(arenaMembers.arenaId, arena.id),
          eq(arenaMembers.userId, userId),
        ),
      )
      .limit(1);

    if (existing && existing.status !== "left") {
      return { ok: false as const, failure: "already_member" as const };
    }

    // Only `active` and `eliminated` members occupy a slot; someone who left
    // has freed theirs. `#5.2` keeps eliminated members visible, so they count.
    const [occupancy] = await tx
      .select({ n: count() })
      .from(arenaMembers)
      .where(
        and(
          eq(arenaMembers.arenaId, arena.id),
          sql`${arenaMembers.status} <> 'left'`,
        ),
      );

    const cap = arena.maxMembers;
    if (cap !== null && Number(occupancy?.n ?? 0) >= cap) {
      return { ok: false as const, failure: "club_full" as const };
    }

    if (existing) {
      // Rejoining: reset to the type's default visibility rather than
      // resurrecting whatever they had before leaving. For an org that is
      // `hidden`, so leaving and rejoining can never quietly re-expose someone.
      const [member] = await tx
        .update(arenaMembers)
        .set({
          status: "active",
          visibility: defaultVisibilityFor(arena.type),
          joinedAt: new Date(),
        })
        .where(
          and(
            eq(arenaMembers.arenaId, arena.id),
            eq(arenaMembers.userId, userId),
          ),
        )
        .returning();
      return { ok: true as const, arena, member: member!, rejoined: true };
    }

    const [member] = await tx
      .insert(arenaMembers)
      .values({
        arenaId: arena.id,
        userId,
        visibility: defaultVisibilityFor(arena.type),
      })
      .returning();

    return { ok: true as const, arena, member: member!, rejoined: false };
  });
}

export type VisibilityFailure = "not_a_member";

/** `#2` — per-arena visibility. `PATCH /v1/me/arenas/:id`. */
export async function setVisibility(
  db: Db,
  userId: string,
  arenaId: string,
  visibility: "public" | "anonymous" | "hidden",
): Promise<
  { ok: true; member: ArenaMember } | { ok: false; failure: VisibilityFailure }
> {
  const [member] = await db
    .update(arenaMembers)
    .set({ visibility })
    .where(
      and(eq(arenaMembers.arenaId, arenaId), eq(arenaMembers.userId, userId)),
    )
    .returning();

  if (!member) return { ok: false, failure: "not_a_member" };
  return { ok: true, member };
}

/**
 * Leave an arena.
 *
 * `status = 'left'` rather than a delete: `#6.2` makes reigns and events
 * append-only, and a foreign key from a reign to a vanished membership would
 * make the hall of fame unrenderable. It also frees the club slot.
 */
export async function leaveArena(
  db: Db,
  userId: string,
  arenaId: string,
): Promise<{ ok: true } | { ok: false; failure: VisibilityFailure }> {
  const [member] = await db
    .update(arenaMembers)
    .set({ status: "left", visibility: "hidden" })
    .where(
      and(eq(arenaMembers.arenaId, arenaId), eq(arenaMembers.userId, userId)),
    )
    .returning();

  return member ? { ok: true } : { ok: false, failure: "not_a_member" };
}

export interface Membership {
  arena: Arena;
  visibility: "public" | "anonymous" | "hidden";
  status: "active" | "eliminated" | "left";
  joinedAt: Date;
  memberCount: number;
  /** Only surfaced to the owner — it is the join secret. */
  inviteCode: string | null;
}

/** Every arena a user belongs to. Powers `GET /v1/me`. */
export async function membershipsFor(
  db: Db,
  userId: string,
): Promise<Membership[]> {
  const rows = await db
    .select({
      arena: arenas,
      visibility: arenaMembers.visibility,
      status: arenaMembers.status,
      joinedAt: arenaMembers.joinedAt,
      memberCount: sql<number>`(
        select count(*)::int from ${arenaMembers} m
        where m.arena_id = ${arenas.id} and m.status <> 'left'
      )`,
    })
    .from(arenaMembers)
    .innerJoin(arenas, eq(arenas.id, arenaMembers.arenaId))
    .where(
      and(
        eq(arenaMembers.userId, userId),
        sql`${arenaMembers.status} <> 'left'`,
      ),
    );

  return rows.map((row) => ({
    arena: row.arena,
    visibility: row.visibility,
    status: row.status,
    joinedAt: row.joinedAt,
    memberCount: Number(row.memberCount),
    // Handing the code to every member would let any one of them invite
    // anyone; the owner controls who gets in.
    inviteCode: row.arena.ownerUserId === userId ? row.arena.inviteCode : null,
  }));
}

/** Rotate a club's invite code. The owner's remedy for a leaked link. */
export async function rotateInviteCode(
  db: Db,
  ownerUserId: string,
  arenaId: string,
): Promise<string | undefined> {
  const [updated] = await db
    .update(arenas)
    .set({ inviteCode: randomCode() })
    .where(
      and(
        eq(arenas.id, arenaId),
        eq(arenas.ownerUserId, ownerUserId),
        eq(arenas.type, "club"),
      ),
    )
    .returning({ inviteCode: arenas.inviteCode });

  return updated?.inviteCode ?? undefined;
}
