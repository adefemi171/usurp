import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, closeDb } from "./client.js";
import { emailChallenges, users } from "./schema.js";
import { issueEmailChallenge, consumeEmailChallenge, linkEmailIdentity, normalizeEmail, invalidateEmailChallenge } from "./email-auth.js";
import { signInWithOAuth } from "./auth.js";

const secret = "test-only-secret-with-thirty-two-characters";
const now = new Date("2026-09-10T12:00:00Z");
const address = () => `test-${crypto.randomUUID()}@example.com`;
it("validates and normalizes email without guessing provider aliases", () => {
  expect(normalizeEmail(" Person+tag@Example.com ")).toBe("person+tag@example.com");
  expect(() => normalizeEmail("bad\r\nemail@example.com")).toThrow();
});
describe.skipIf(!process.env.DATABASE_URL)("passwordless email authentication", () => {
  const addresses: string[] = []; const userIds: string[] = [];
  afterAll(closeDb);
  afterEach(async () => { const db = getDb(); for (const email of addresses.splice(0)) await db.delete(emailChallenges).where(eq(emailChallenges.email, email)); for (const id of userIds.splice(0)) await db.delete(users).where(eq(users.id, id)); });
  async function issue(linkUserId?: string) { const email = address(); addresses.push(email); return issueEmailChallenge(getDb(), { email, secret, returnTo: "/connect/approve?code=test", ...(linkUserId ? { linkUserId } : {}) }, now); }
  it("stores no plaintext code/token and permits exactly one concurrent redemption", async () => {
    const c = await issue();
    const [stored] = await getDb().select().from(emailChallenges).where(eq(emailChallenges.email, c.email));
    expect(JSON.stringify(stored)).not.toContain(c.code); expect(stored?.idHash).not.toBe(c.token);
    const results = await Promise.all([1, 2].map(() => consumeEmailChallenge(getDb(), c.token, c.code, secret, undefined, now)));
    expect(results.filter(Boolean)).toHaveLength(1); expect(results.find(Boolean)?.returnTo).toContain("/connect/approve?");
  });
  it("rejects wrong-browser tokens, expired codes and more than five guesses", async () => {
    const c = await issue();
    expect(await consumeEmailChallenge(getDb(), "x".repeat(43), c.code, secret, undefined, now)).toBeUndefined();
    const wrong = c.code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 5; i++) expect(await consumeEmailChallenge(getDb(), c.token, wrong, secret, undefined, now)).toBeUndefined();
    expect(await consumeEmailChallenge(getDb(), c.token, c.code, secret, undefined, now)).toBeUndefined();
    const expired = await issue();
    expect(await consumeEmailChallenge(getDb(), expired.token, expired.code, secret, undefined, new Date(+now + 600_000))).toBeUndefined();
  });
  it("throttles requests and invalidates undelivered challenges", async () => {
    const c = await issue();
    await expect(issueEmailChallenge(getDb(), { email: c.email, secret, returnTo: "/" }, now)).rejects.toThrow("email_rate_limited");
    await invalidateEmailChallenge(getDb(), c.token);
    expect(await consumeEmailChallenge(getDb(), c.token, c.code, secret, undefined, now)).toBeUndefined();
  });
  it("links email only to the authenticated account and never merges by matching GitHub email", async () => {
    const db = getDb(); const email = address();
    const github = await signInWithOAuth(db, { provider: "github", providerUid: crypto.randomUUID(), email }); userIds.push(github.user.id);
    const c = await issue(github.user.id);
    expect(await consumeEmailChallenge(db, c.token, c.code, secret, undefined, now)).toBeUndefined();
    expect(await consumeEmailChallenge(db, c.token, c.code, secret, github.user.id, now)).toBeDefined();
    expect(await linkEmailIdentity(db, github.user.id, c.email)).toBe(true);
    const same = await signInWithOAuth(db, { provider: "email", providerUid: c.email, email: c.email });
    expect(same.user.id).toBe(github.user.id);
    const separate = await signInWithOAuth(db, { provider: "email", providerUid: email, email }); userIds.push(separate.user.id);
    expect(separate.user.id).not.toBe(github.user.id);
    expect(await linkEmailIdentity(db, github.user.id, email)).toBe(false);
  });
});
