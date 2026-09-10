import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { usageReviews, users } from "./schema.js";

/** Operator-only entry point. There is intentionally no public moderation API. */
export async function setUsageReview(
  db: Db,
  userId: string,
  state: "clear" | "shadow_frozen",
  reason: string,
  reviewer: string,
  now = new Date(),
) {
  if (
    !["clear", "shadow_frozen"].includes(state) ||
    reason.trim().length < 8 ||
    reason.length > 500 ||
    !reviewer.trim() ||
    reviewer.length > 100
  )
    throw Error("invalid_review");
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) throw Error("user_not_found");
    if (user.reviewState === state) return false;
    await tx
      .update(users)
      .set({ reviewState: state })
      .where(eq(users.id, userId));
    await tx
      .insert(usageReviews)
      .values({
        userId,
        state,
        reason: reason.trim(),
        reviewer: reviewer.trim(),
        createdAt: now,
      });
    return true;
  });
}

/** Conservative signal only: pricing gaps and large token totals never freeze users. */
export async function reviewSuspiciousUsage(
  db: Db,
  userId: string,
  now = new Date(),
) {
  const [lastClear] = await db
    .select()
    .from(usageReviews)
    .where(
      and(eq(usageReviews.userId, userId), eq(usageReviews.state, "clear")),
    )
    .orderBy(desc(usageReviews.createdAt))
    .limit(1);
  const since = new Date(
    Math.max(+now - 86400_000, lastClear ? +lastClear.createdAt : 0),
  );
  const [result] =
    await db.execute(sql`select count(distinct hour)::int as hours from usage_events
    where user_id=${userId} and sig_ok and not historical and hour >= ${since.toISOString()}::timestamptz
      and hour <= ${now.toISOString()}::timestamptz and flags @> '["commits_per_hour_exceeded"]'::jsonb`);
  if (Number(result?.hours ?? 0) < 3) return false;
  return setUsageReview(
    db,
    userId,
    "shadow_frozen",
    "Commit plausibility ceiling exceeded in three distinct hours within 24 hours.",
    "automated:commit-ceiling-v1",
    now,
  );
}
