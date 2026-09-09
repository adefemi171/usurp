/**
 * Device enrollment.
 *
 * M0 has no OAuth — that is `#9` M1 — so a device is registered by redeeming a
 * one-time code an operator generates. The shape is chosen to survive the move
 * to OAuth unchanged: `redeemEnrollment` already returns a device bound to a
 * user, so M1 only has to change how the code is issued.
 *
 * Only the SHA-256 of a code is stored. A leak of `device_enrollments` yields
 * no redeemable codes.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { PublicKeyB64 } from "@usurp/protocol";
import type { Db } from "./client.js";
import { deviceEnrollments, devices, users, type Device } from "./schema.js";

/** How long a freshly issued code stays redeemable. */
export const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

/**
 * Code alphabet: Crockford base32 without `I`, `L`, `O`, `U`.
 *
 * Codes get read off a terminal and typed into another one, so the confusable
 * characters are worth losing. Excluding `U` also avoids accidental profanity.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 20 characters over a 32-symbol alphabet — 100 bits, well past guessable. */
const CODE_LENGTH = 20;

function randomCode(length: number): string {
  // Rejection-free: 256 is not a multiple of 32, so take 5 bits per byte.
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

function hashCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code), "utf8").digest("hex");
}

/** Accept a code however the user typed it: spacing, dashes, or lowercase. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Group into blocks of 5 for a human to read aloud or retype. */
export function formatCode(code: string): string {
  return (code.match(/.{1,5}/g) ?? []).join("-");
}

export function newDeviceId(): string {
  return `dev_${randomCode(16)}`;
}

export interface IssuedEnrollment {
  /** Show once, then it is unrecoverable. */
  code: string;
  expiresAt: Date;
}

/** Issue a one-time enrollment code for a user. */
export async function issueEnrollment(
  db: Db,
  userId: string,
  options: { label?: string; now?: Date } = {},
): Promise<IssuedEnrollment> {
  const now = options.now ?? new Date();
  const code = randomCode(CODE_LENGTH);
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);

  await db.insert(deviceEnrollments).values({
    codeHash: hashCode(code),
    userId,
    label: options.label ?? null,
    expiresAt,
    createdAt: now,
  });

  return { code: formatCode(code), expiresAt };
}

export type RedeemFailure = "invalid_code" | "code_used" | "code_expired";

export type RedeemResult =
  | { ok: true; device: Device; reused: boolean }
  | { ok: false; failure: RedeemFailure };

/**
 * Redeem a code, registering `publicKey` as a device.
 *
 * If the key is already registered, the existing device is returned and the
 * code is *not* consumed. Handing back a fresh `device_id` for a key whose
 * `last_seq` is already at N would reset the counter to 0 and reopen the replay
 * window that `#3.4` closes.
 */
export async function redeemEnrollment(
  db: Db,
  code: string,
  publicKey: PublicKeyB64,
  options: { label?: string; now?: Date } = {},
): Promise<RedeemResult> {
  const now = options.now ?? new Date();
  const codeHash = hashCode(code);

  return db.transaction(async (tx) => {
    // Lock the row so two concurrent redemptions of one code cannot both pass
    // the `used_at IS NULL` check.
    const [enrollment] = await tx
      .select()
      .from(deviceEnrollments)
      .where(eq(deviceEnrollments.codeHash, codeHash))
      .limit(1)
      .for("update");

    if (!enrollment) return { ok: false as const, failure: "invalid_code" as const };
    if (enrollment.usedAt) return { ok: false as const, failure: "code_used" as const };
    if (enrollment.expiresAt.getTime() <= now.getTime()) {
      return { ok: false as const, failure: "code_expired" as const };
    }

    const [existing] = await tx
      .select()
      .from(devices)
      .where(eq(devices.publicKey, publicKey))
      .limit(1);

    if (existing) {
      // Idempotent re-login. The code stays unused and still expires normally.
      return { ok: true as const, device: existing, reused: true };
    }

    const [device] = await tx
      .insert(devices)
      .values({
        id: newDeviceId(),
        userId: enrollment.userId,
        publicKey,
        label: options.label ?? enrollment.label ?? null,
        trustTier: "cli_signed",
        createdAt: now,
      })
      .returning();

    await tx
      .update(deviceEnrollments)
      .set({ usedAt: now, deviceId: device!.id })
      .where(eq(deviceEnrollments.codeHash, codeHash));

    return { ok: true as const, device: device!, reused: false };
  });
}

/** Find or create a user by handle. Used by the operator enrollment script. */
export async function upsertUserByHandle(db: Db, handle: string) {
  const [existing] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.handle}) = lower(${handle})`)
    .limit(1);
  if (existing) return existing;

  const [created] = await db.insert(users).values({ handle }).returning();
  return created!;
}

/** Drop expired, unredeemed codes. Wired to a job in M1. */
export async function pruneEnrollments(db: Db, now = new Date()): Promise<void> {
  await db
    .delete(deviceEnrollments)
    .where(
      and(isNull(deviceEnrollments.usedAt), sql`${deviceEnrollments.expiresAt} <= ${now}`),
    );
}

/**
 * Constant-time comparison helper, exported for callers that need to compare a
 * secret outside the hash path. Falls back to `false` on length mismatch rather
 * than throwing, which `timingSafeEqual` otherwise does.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
