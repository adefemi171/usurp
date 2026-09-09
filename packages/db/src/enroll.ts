/**
 * Operator script: mint a device enrollment code.
 *
 *   npm run enroll -- --handle kenn [--label "laptop"]
 *
 * This is M0's stand-in for OAuth (`#9` M1). It creates the user if needed,
 * enrols them in the global arena, and prints a code valid for 15 minutes.
 */

import { closeDb, getDb } from "./client.js";
import { issueEnrollment, upsertUserByHandle } from "./enrollment.js";
import { joinGlobalArena } from "./seed.js";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

async function main(): Promise<void> {
  const handle = arg("handle");
  if (!handle) {
    console.error("usage: npm run enroll -- --handle <handle> [--label <label>]");
    process.exit(2);
  }
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(handle)) {
    console.error("handle must be 2-32 characters of [a-zA-Z0-9_-]");
    process.exit(2);
  }

  const db = getDb();
  const user = await upsertUserByHandle(db, handle);
  await joinGlobalArena(db, user.id);

  const label = arg("label");
  const { code, expiresAt } = await issueEnrollment(db, user.id, label ? { label } : {});

  const api = process.env.USURP_API_URL ?? "http://localhost:3000";
  console.log(`\nuser    ${user.handle}  (${user.id})`);
  console.log(`expires ${expiresAt.toISOString()}\n`);
  console.log(`  npm run usurp -- login ${code} --api ${api}\n`);
  console.log("This code is shown once and cannot be recovered.\n");
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error("enrollment failed:", err instanceof Error ? err.message : err);
    await closeDb().catch(() => {});
    process.exit(1);
  });
