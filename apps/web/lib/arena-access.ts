import { and, eq, sql } from "drizzle-orm";
import { arenaMembers, arenas, getDb } from "@usurp/db";

/** Private clubs and organizations are not public simply because a slug is known. */
export async function canViewArena(slug: string, viewerId?: string) {
  const [arena] = await getDb()
    .select()
    .from(arenas)
    .where(eq(arenas.slug, slug));
  if (!arena) return false;
  if (arena.type === "global") return true;
  if (!viewerId) return false;
  if (arena.ownerUserId === viewerId) return true;
  const [member] = await getDb()
    .select({ id: arenaMembers.userId })
    .from(arenaMembers)
    .where(
      and(
        eq(arenaMembers.arenaId, arena.id),
        eq(arenaMembers.userId, viewerId),
        sql`${arenaMembers.status} <> 'left'`,
      ),
    );
  return Boolean(member);
}
