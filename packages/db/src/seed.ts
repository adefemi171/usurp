/**
 * Seed data.
 *
 * Only the global arena, which `#2` says users are auto-enrolled into on
 * opt-in. Everything else — clubs, orgs, seasons — is created by users or by
 * jobs that arrive in later milestones.
 */

import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { arenaMembers, arenas, type Arena } from "./schema.js";

export const GLOBAL_ARENA_SLUG = "global";

/** Idempotent: returns the existing arena if it is already there. */
export async function seedGlobalArena(db: Db): Promise<Arena> {
  const [existing] = await db
    .select()
    .from(arenas)
    .where(eq(arenas.slug, GLOBAL_ARENA_SLUG))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(arenas)
    .values({
      type: "global",
      name: "Global",
      slug: GLOBAL_ARENA_SLUG,
      // `#2` — global is unbounded.
      maxMembers: null,
    })
    .returning();

  return created!;
}

/**
 * Enrol a user in the global arena.
 *
 * `#2` — global is opt-in, and `public` is the right default *here* only: an
 * org arena defaults to `hidden`, which is why visibility is set per membership
 * rather than inherited from the arena.
 *
 * `DO UPDATE`, not `DO NOTHING`. `#10.2` promises every arena is independently
 * leavable, and leaving is recorded as `status = 'left'` rather than a delete
 * (`#6.2` keeps history intact). With `DO NOTHING`, someone who left and then
 * opted back in would hit the existing row, change nothing, and stay silently
 * `left` — able to ask to rejoin forever without ever rejoining.
 */
export async function joinGlobalArena(db: Db, userId: string): Promise<void> {
  const arena = await seedGlobalArena(db);
  await db
    .insert(arenaMembers)
    .values({ arenaId: arena.id, userId, visibility: "public" })
    .onConflictDoUpdate({
      target: [arenaMembers.arenaId, arenaMembers.userId],
      set: { status: "active", visibility: "public", shareTools: false, joinedAt: new Date() },
      // Only touch a membership that was actually abandoned. Without this,
      // re-opting-in would reset a current member's visibility back to public —
      // quietly un-hiding someone who chose to be hidden.
      setWhere: sql`${arenaMembers.status} = 'left'`,
    });
}
