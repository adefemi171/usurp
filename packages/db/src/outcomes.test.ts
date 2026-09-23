import { afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { generateDeviceKeyPair, signOutcome } from "@usurp/protocol";
import { getDb, closeDb } from "./client.js";
import { users, outcomeAttestors, arenaMembers, outcomeReceipts } from "./schema.js";
import { acceptOutcome, outcomeBoard } from "./outcomes.js";
import { joinGlobalArena } from "./seed.js";

describe.skipIf(!process.env.DATABASE_URL)("outcome persistence and visibility", () => {
  afterAll(closeDb);
  it("deduplicates retries, rejects tampering and enforces approval, consent, anonymity, hidden membership and revocation", async () => {
    const db = getDb(), keys = generateDeviceKeyPair();
    const [user] = await db.insert(users).values({ handle: `proof_${randomUUID().slice(0, 12)}` }).returning();
    const value = signOutcome({ version: 1, id: randomUUID(), missionId: randomUUID(), publicKey: keys.publicKey, kind: "test", passed: true, startedAt: "2026-09-22T00:00:00.000Z", finishedAt: "2026-09-22T00:00:01.000Z", durationMs: 1000 }, keys.privateKeyPem);
    try {
      expect((await acceptOutcome(db, value)).ok).toBe(false);
      await db.insert(outcomeAttestors).values({ publicKey: keys.publicKey, userId: user!.id });
      expect((await acceptOutcome(db, { ...value, outcome: { ...value.outcome, passed: false } })).ok).toBe(false);
      expect((await acceptOutcome(db, value)).ok).toBe(true);
      expect((await acceptOutcome(db, value)).ok).toBe(true);
      expect(await db.select().from(outcomeReceipts).where(eq(outcomeReceipts.publicKey, keys.publicKey))).toHaveLength(1);
      expect((await acceptOutcome(db, signOutcome({ ...value.outcome, passed: false }, keys.privateKeyPem))).ok).toBe(false);
      await joinGlobalArena(db, user!.id);
      expect(await outcomeBoard(db, [keys.publicKey])).toHaveLength(0);
      await db.update(outcomeAttestors).set({ share: true }).where(eq(outcomeAttestors.publicKey, keys.publicKey));
      await db.update(arenaMembers).set({ visibility: "public" }).where(eq(arenaMembers.userId, user!.id));
      expect(await outcomeBoard(db, [])).toHaveLength(0);
      expect(await outcomeBoard(db, [keys.publicKey])).toEqual([expect.objectContaining({ name: user!.handle, completed: 1, score: 100 })]);
      const again = signOutcome({ ...value.outcome, id: randomUUID() }, keys.privateKeyPem);
      await acceptOutcome(db, again);
      expect((await outcomeBoard(db, [keys.publicKey]))[0]?.score).toBe(100);
      await db.update(arenaMembers).set({ visibility: "anonymous" }).where(eq(arenaMembers.userId, user!.id));
      expect(JSON.stringify(await outcomeBoard(db, [keys.publicKey]))).not.toContain(user!.handle);
      await db.update(arenaMembers).set({ visibility: "hidden" }).where(eq(arenaMembers.userId, user!.id));
      expect(await outcomeBoard(db, [keys.publicKey])).toHaveLength(0);
      await db.update(arenaMembers).set({ visibility: "public" }).where(eq(arenaMembers.userId, user!.id));
      await db.update(outcomeAttestors).set({ revokedAt: new Date() }).where(eq(outcomeAttestors.publicKey, keys.publicKey));
      expect(await outcomeBoard(db, [keys.publicKey])).toHaveLength(0);
      expect((await acceptOutcome(db, value)).ok).toBe(false);
    } finally { await db.delete(users).where(eq(users.id, user!.id)); }
  });
});
