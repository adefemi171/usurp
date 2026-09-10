import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  arenas,
  orgDomains,
  emailChallenges,
  identities,
  users,
} from "./schema.js";

/** Explicit account erasure. FK cascades purge usage, snapshots, keys and sessions. */
export async function deleteAccount(
  db: Db,
  userId: string,
  confirmation: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user || confirmation !== user.handle) return false;
    // Anonymous sign-in challenges have no user FK but still contain the email.
    const emails = await tx
      .select({ email: identities.providerUid })
      .from(identities)
      .where(
        and(eq(identities.userId, userId), eq(identities.provider, "email")),
      );
    if (emails.length)
      await tx.delete(emailChallenges).where(
        inArray(
          emailChallenges.email,
          emails.map((e) => e.email),
        ),
      );
    // Preserve other members' arenas, but release the deleted admin's domain
    // claim so an orphaned organization cannot permanently reserve a domain.
    const owned = await tx
      .select({ id: arenas.id })
      .from(arenas)
      .where(eq(arenas.ownerUserId, userId));
    if (owned.length)
      await tx.delete(orgDomains).where(
        inArray(
          orgDomains.arenaId,
          owned.map((a) => a.id),
        ),
      );
    await tx.delete(users).where(eq(users.id, userId));
    return true;
  });
}
