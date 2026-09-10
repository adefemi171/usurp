import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { emailChallenges, identities } from "./schema.js";

export const EMAIL_CODE_TTL_MS = 10 * 60_000;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const digest = (token: string, code: string, secret: string) => createHmac("sha256", secret).update(`${token}:${code}`).digest("hex");
export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) throw new Error("invalid_email");
  return email;
}

export async function issueEmailChallenge(db: Db, input: { email: string; secret: string; returnTo: string; linkUserId?: string }, now = new Date()) {
  const email = normalizeEmail(input.email);
  return db.transaction(async tx => {
    // Bound mail abuse across replicas, without trusting spoofable IP headers.
    await tx.execute(sql`select pg_advisory_xact_lock(73193018)`);
    await tx.delete(emailChallenges).where(lte(emailChallenges.createdAt, new Date(+now - 86400_000)));
    const recent = await tx.select().from(emailChallenges).where(gt(emailChallenges.createdAt, new Date(+now - 3600_000)));
    const own = recent.filter(r => r.email === email);
    if (recent.length >= 300 || own.length >= 5 || own.some(r => +r.createdAt > +now - 60_000)) throw new Error("email_rate_limited");
    const token = randomBytes(32).toString("base64url");
    const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const expiresAt = new Date(+now + EMAIL_CODE_TTL_MS);
    await tx.insert(emailChallenges).values({ idHash: hash(token), email, codeHash: digest(token, code, input.secret), returnTo: input.returnTo,
      linkUserId: input.linkUserId ?? null, createdAt: now, expiresAt });
    return { token, code, expiresAt, email };
  });
}

export async function consumeEmailChallenge(db: Db, token: string, code: string, secret: string, linkUserId?: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  return db.transaction(async tx => {
    const [row] = await tx.select().from(emailChallenges).where(eq(emailChallenges.idHash, hash(token))).for("update");
    if (!row || row.consumedAt || row.expiresAt <= now || row.attempts >= 5 || (row.linkUserId ?? undefined) !== linkUserId) return undefined;
    await tx.update(emailChallenges).set({ attempts: row.attempts + 1 }).where(eq(emailChallenges.idHash, row.idHash));
    if (!/^\d{8}$/.test(code) || !timingSafeEqual(Buffer.from(row.codeHash, "hex"), Buffer.from(digest(token, code, secret), "hex"))) return undefined;
    await tx.update(emailChallenges).set({ consumedAt: now }).where(eq(emailChallenges.idHash, row.idHash));
    return { email: row.email, returnTo: row.returnTo, linkUserId: row.linkUserId };
  });
}

export async function invalidateEmailChallenge(db: Db, token: string) {
  await db.update(emailChallenges).set({ consumedAt: new Date() }).where(eq(emailChallenges.idHash, hash(token)));
}

/** Linking always requires an existing authenticated session AND email proof. */
export async function linkEmailIdentity(db: Db, userId: string, email: string) {
  const normalized = normalizeEmail(email);
  await db.insert(identities).values({ provider: "email", providerUid: normalized, userId }).onConflictDoNothing();
  const [identity] = await db.select().from(identities).where(and(eq(identities.provider, "email"), eq(identities.providerUid, normalized)));
  return identity?.userId === userId;
}
