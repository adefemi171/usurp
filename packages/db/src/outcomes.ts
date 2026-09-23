import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { canonicalJson, signedOutcomeSchema, verifyOutcome, type SignedOutcome } from "@usurp/protocol";
import type { Db } from "./client.js";
import { outcomeAttestors, outcomeReceipts, users, arenaMembers, arenas } from "./schema.js";
import { pseudonymFor } from "./board.js";

export async function acceptOutcome(db: Db, value: SignedOutcome, now = new Date()) {
  const parsed = signedOutcomeSchema.safeParse(value);
  if (!parsed.success || !verifyOutcome(parsed.data) || Date.parse(value.outcome.finishedAt) > now.getTime() + 300000) return { ok: false, error: "invalid_proof" } as const;
  return db.transaction(async tx => {
    const [attestor] = await tx.select().from(outcomeAttestors).where(and(eq(outcomeAttestors.publicKey, value.outcome.publicKey), isNull(outcomeAttestors.revokedAt))).for("update");
    if (!attestor) return { ok: false, error: "unlinked_or_revoked" } as const;
    // Immutable identity makes offline replay safe, including lost acknowledgements.
    await tx.insert(outcomeReceipts).values({ id: value.outcome.id, publicKey: value.outcome.publicKey, missionId: value.outcome.missionId, payload: value }).onConflictDoNothing();
    const [stored] = await tx.select().from(outcomeReceipts).where(eq(outcomeReceipts.id, value.outcome.id));
    if (!stored || canonicalJson(stored.payload) !== canonicalJson(value)) return { ok: false, error: "conflicting_id" } as const;
    return { ok: true, accepted: value.outcome.id } as const;
  });
}

/** Global arena only; key approval, member visibility and sharing are checked on every read. */
export async function outcomeBoard(db: Db, trustedKeys: string[]) {
  if (!trustedKeys.length) return [];
  const rows = await db.select({ userId: users.id, handle: users.handle, visibility: arenaMembers.visibility,
    completed: sql<number>`count(distinct ${outcomeReceipts.missionId}) filter (where ${outcomeReceipts.payload}->'outcome'->>'passed' = 'true')::int`,
    attempted: sql<number>`count(distinct ${outcomeReceipts.missionId})::int`,
  }).from(outcomeReceipts)
    .innerJoin(outcomeAttestors, eq(outcomeAttestors.publicKey, outcomeReceipts.publicKey))
    .innerJoin(users, eq(users.id, outcomeAttestors.userId))
    .innerJoin(arenaMembers, eq(arenaMembers.userId, users.id))
    .innerJoin(arenas, eq(arenas.id, arenaMembers.arenaId))
    .where(and(inArray(outcomeAttestors.publicKey, trustedKeys), isNull(outcomeAttestors.revokedAt), eq(outcomeAttestors.share, true), eq(arenas.slug, "global"), eq(arenaMembers.status, "active"), eq(users.reviewState, "clear"), sql`${arenaMembers.visibility} <> 'hidden'`))
    .groupBy(users.id, users.handle, arenaMembers.visibility);
  // Completion score rewards successful outcomes only. No invented cost attribution.
  return rows.map(r => ({ name: r.visibility === "anonymous" ? pseudonymFor(r.userId) : r.handle, completed: Number(r.completed), attempted: Number(r.attempted), score: Number(r.completed) * 100, completionRate: Math.round(Number(r.completed) / Math.max(1, Number(r.attempted)) * 100) }))
    .sort((a, b) => b.score - a.score || b.completionRate - a.completionRate || a.name.localeCompare(b.name));
}
