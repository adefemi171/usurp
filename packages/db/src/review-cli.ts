import { eq } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import { users, usageReviews } from "./schema.js";
import { setUsageReview } from "./review.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
try {
  const handle = arg("handle"),
    decision = arg("decision"),
    reason = arg("reason"),
    reviewer = arg("reviewer");
  if (!handle)
    throw Error(
      "Usage: npm run review -- --handle HANDLE [--decision clear|shadow_frozen --reason REASON --reviewer NAME --apply]",
    );
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.handle, handle));
  if (!user) throw Error("User not found");
  if (process.argv.includes("--apply")) {
    if (
      (decision !== "clear" && decision !== "shadow_frozen") ||
      !reason ||
      !reviewer
    )
      throw Error("Decision, reason and reviewer are required with --apply");
    console.log(
      JSON.stringify({
        changed: await setUsageReview(db, user.id, decision, reason, reviewer),
      }),
    );
  } else {
    const history = await db
      .select()
      .from(usageReviews)
      .where(eq(usageReviews.userId, user.id));
    console.log(
      JSON.stringify(
        { handle: user.handle, state: user.reviewState, history },
        null,
        2,
      ),
    );
    console.log(
      "Read-only preview. Add --apply with a decision, reason and reviewer to change the review state.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Review failed");
  process.exitCode = 1;
} finally {
  await closeDb();
}
