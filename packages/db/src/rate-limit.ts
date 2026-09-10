import { createHash } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { requestLimits } from "./schema.js";

/** Atomic shared budget. Stores a digest, never an IP, email, cookie or key. */
export async function consumeRateLimit(
  db: Db,
  scope: string,
  subject: string,
  limit: number,
  windowMs: number,
  now = new Date(),
): Promise<{ allowed: boolean; retryAfter: number }> {
  if (!Number.isInteger(limit) || limit < 1 || windowMs < 1000)
    throw new Error("invalid_rate_limit");
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  const expiresAt = new Date(start + windowMs);
  const key = createHash("sha256")
    .update(JSON.stringify([scope, subject, start]))
    .digest("hex");
  const [row] = await db
    .insert(requestLimits)
    .values({ key, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: requestLimits.key,
      set: { count: sql`least(${requestLimits.count} + 1, ${limit + 1})` },
    })
    .returning({ count: requestLimits.count });
  return {
    allowed: row!.count <= limit,
    retryAfter: Math.max(
      1,
      Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
    ),
  };
}

export async function pruneRequestLimits(db: Db, now = new Date()) {
  await db.delete(requestLimits).where(lt(requestLimits.expiresAt, now));
}
