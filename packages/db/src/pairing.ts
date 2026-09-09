import { createHash, randomBytes } from "node:crypto";
import { eq, lte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { devicePairings, devices, users } from "./schema.js";
import { newDeviceId, normalizeCode } from "./enrollment.js";

export const PAIRING_TTL_MS = 10 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const codeHash = (code: string) => hash(normalizeCode(code));

export async function startPairing(db: Db, publicKey: string, label: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(publicKey) || Buffer.from(publicKey, "base64url").length !== 32 ||
      Buffer.from(publicKey, "base64url").toString("base64url") !== publicKey) throw new Error("invalid_public_key");
  if (!label.trim() || label.length > 64) throw new Error("invalid_label");
  return db.transaction(async tx => {
    // Shared DB budget works across app replicas, without trusting client IP headers.
    await tx.execute(sql`select pg_advisory_xact_lock(73193017)`);
    await tx.delete(devicePairings).where(lte(devicePairings.expiresAt, now));
    const counts = await tx.select({ count: sql<number>`count(*)::int` }).from(devicePairings);
    if (counts[0]!.count >= 500) throw new Error("pairing_busy");
    const existing = await tx.select().from(devicePairings).where(eq(devicePairings.publicKey, publicKey));
    if (existing.length) throw new Error("pairing_exists");
    const registered = await tx.select().from(devices).where(eq(devices.publicKey, publicKey));
    if (registered.length) throw new Error("key_registered");
    const raw = randomBytes(6).toString("hex").toUpperCase();
    const code = raw.match(/.{4}/g)!.join("-");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    await tx.insert(devicePairings).values({ codeHash: codeHash(code), tokenHash: hash(token), publicKey, label: label.trim(), expiresAt });
    return { code, token, expiresAt, interval: 5 };
  });
}

export async function inspectPairing(db: Db, code: string, now = new Date()) {
  const [row] = await db.select().from(devicePairings).where(eq(devicePairings.codeHash, codeHash(code)));
  if (!row || row.expiresAt <= now || row.decision) return undefined;
  return { label: row.label, fingerprint: hash(row.publicKey).slice(0, 16), expiresAt: row.expiresAt };
}

export async function decidePairing(db: Db, code: string, userId: string, approve: boolean, now = new Date()) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(devicePairings).where(eq(devicePairings.codeHash, codeHash(code))).for("update");
    if (!row || row.expiresAt <= now || row.decision) return false;
    let deviceId: string | null = null;
    if (approve) {
      deviceId = newDeviceId();
      // Never reassign an existing key to a different account, including revoked keys.
      const inserted = await tx.insert(devices).values({ id: deviceId, userId, publicKey: row.publicKey, label: row.label, trustTier: "cli_signed" }).onConflictDoNothing().returning();
      if (!inserted.length) return false;
    }
    await tx.update(devicePairings).set({ decision: approve ? "approved" : "denied", deviceId }).where(eq(devicePairings.codeHash, row.codeHash));
    return true;
  });
}

export async function pollPairing(db: Db, token: string, now = new Date()) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(devicePairings).where(eq(devicePairings.tokenHash, hash(token))).for("update");
    if (!row || row.expiresAt <= now) return { status: "expired" as const };
    if (row.lastPolledAt && now.getTime() - row.lastPolledAt.getTime() < 5000) return { status: "slow_down" as const };
    await tx.update(devicePairings).set({ lastPolledAt: now }).where(eq(devicePairings.codeHash, row.codeHash));
    if (!row.decision) return { status: "pending" as const };
    if (!row.deviceId) return { status: "denied" as const };
    const [device] = await tx.select({ id: devices.id, revokedAt: devices.revokedAt, handle: users.handle }).from(devices).innerJoin(users, eq(devices.userId, users.id)).where(eq(devices.id, row.deviceId));
    if (!device || device.revokedAt) return { status: "denied" as const };
    // Retrying a lost response returns the same device, never a second registration.
    return { status: "approved" as const, deviceId: device.id, handle: device.handle };
  });
}

/** Cancellation cannot discard a device whose browser approval already won. */
export async function cancelPairing(db: Db, token: string) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(devicePairings).where(eq(devicePairings.tokenHash, hash(token))).for("update");
    if (!row) return true;
    if (row.deviceId) return false;
    await tx.update(devicePairings).set({ decision: "denied" }).where(eq(devicePairings.codeHash, row.codeHash));
    return true;
  });
}
