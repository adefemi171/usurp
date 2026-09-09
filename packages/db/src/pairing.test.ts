import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateDeviceKeyPair } from "@usurp/protocol";
import { closeDb, getDb } from "./client.js";
import { devicePairings, devices, users, arenaMembers } from "./schema.js";
import { startPairing, inspectPairing, decidePairing, pollPairing, cancelPairing, PAIRING_TTL_MS } from "./pairing.js";

describe.skipIf(!process.env.DATABASE_URL)("browser device pairing", () => {
  const now = new Date("2026-09-09T20:00:00Z");
  let userId: string;
  let keys: ReturnType<typeof generateDeviceKeyPair>;
  beforeEach(async () => {
    const db = getDb();
    await db.delete(devicePairings);
    await db.delete(users).where(eq(users.handle, "pairing_test"));
    userId = (await db.insert(users).values({ handle: "pairing_test" }).returning())[0]!.id;
    keys = generateDeviceKeyPair();
  });
  afterAll(async () => { await getDb().delete(devicePairings); await getDb().delete(users).where(eq(users.handle, "pairing_test")); await closeDb(); });
  it("binds browser approval to the original key, with no automatic public membership", async () => {
    const db = getDb();
    const request = await startPairing(db, keys.publicKey, "Test computer", now);
    expect(await inspectPairing(db, request.code, now)).toMatchObject({ label: "Test computer" });
    const stored = await db.select().from(devicePairings);
    expect(JSON.stringify(stored)).not.toContain(request.token);
    expect(JSON.stringify(stored)).not.toContain(request.code);
    expect(await pollPairing(db, request.code, now)).toEqual({ status: "expired" });
    expect(await pollPairing(db, request.token, now)).toEqual({ status: "pending" });
    expect(await decidePairing(db, request.code, userId, true, now)).toBe(true);
    const result = await pollPairing(db, request.token, new Date(+now + 5000));
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw new Error("approval failed");
    const [device] = await db.select().from(devices).where(eq(devices.id, result.deviceId));
    expect(device).toMatchObject({ userId, publicKey: keys.publicKey, lastSeq: 0 });
    expect(await db.select().from(arenaMembers).where(eq(arenaMembers.userId, userId))).toEqual([]);
    expect(await pollPairing(db, request.token, new Date(+now + 10_000))).toEqual(result);
  });
  it("allows only one competing approval to create a device", async () => {
    const db = getDb(); const request = await startPairing(db, keys.publicKey, "Race", now);
    const results = await Promise.all([decidePairing(db, request.code, userId, true, now), decidePairing(db, request.code, userId, true, now)]);
    expect(results.sort()).toEqual([false, true]);
    expect(await db.select().from(devices).where(eq(devices.publicKey, keys.publicKey))).toHaveLength(1);
  });
  it("enforces polling intervals and expiry", async () => {
    const db = getDb(); const request = await startPairing(db, keys.publicKey, "Expiry", now);
    await pollPairing(db, request.token, now);
    expect(await pollPairing(db, request.token, new Date(+now + 4999))).toEqual({ status: "slow_down" });
    expect(await pollPairing(db, request.token, new Date(+now + PAIRING_TTL_MS))).toEqual({ status: "expired" });
    expect(await decidePairing(db, request.code, userId, true, new Date(+now + PAIRING_TTL_MS))).toBe(false);
  });
  it("never approves a denied request or a registered key", async () => {
    const db = getDb(); const request = await startPairing(db, keys.publicKey, "Denied", now);
    expect(await decidePairing(db, request.code, userId, false, now)).toBe(true);
    expect(await decidePairing(db, request.code, userId, true, now)).toBe(false);
    expect(await pollPairing(db, request.token, now)).toEqual({ status: "denied" });
    await db.insert(devices).values({ id: "dev_pairing_registered", userId, publicKey: generateDeviceKeyPair().publicKey, trustTier: "cli_signed" });
    const [registered] = await db.select().from(devices).where(eq(devices.id, "dev_pairing_registered"));
    await expect(startPairing(db, registered!.publicKey, "Other account", now)).rejects.toThrow("key_registered");
  });
  it("does not hand out a device revoked before the desktop claims it", async () => {
    const db = getDb(); const request = await startPairing(db, keys.publicKey, "Revoked", now);
    await decidePairing(db, request.code, userId, true, now);
    await db.update(devices).set({ revokedAt: now }).where(eq(devices.publicKey, keys.publicKey));
    expect(await pollPairing(db, request.token, now)).toEqual({ status: "denied" });
  });
  it("rejects invalid keys and duplicate pending requests", async () => {
    await expect(startPairing(getDb(), "invalid", "Device", now)).rejects.toThrow("invalid_public_key");
    await startPairing(getDb(), keys.publicKey, "Device", now);
    await expect(startPairing(getDb(), keys.publicKey, "Device", now)).rejects.toThrow("pairing_exists");
  });
  it("cancels pending requests but preserves an already-approved device", async () => {
    const db = getDb(); const request = await startPairing(db, keys.publicKey, "Cancel", now);
    expect(await cancelPairing(db, request.token)).toBe(true);
    expect(await decidePairing(db, request.code, userId, true, now)).toBe(false);
    const second = await startPairing(db, generateDeviceKeyPair().publicKey, "Approved", now);
    await decidePairing(db, second.code, userId, true, now);
    expect(await cancelPairing(db, second.token)).toBe(false);
    expect((await pollPairing(db, second.token, now)).status).toBe("approved");
  });
});
