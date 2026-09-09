/**
 * Apply migrations, then seed the global arena.
 *
 * Safe to run repeatedly: Drizzle skips applied migrations, and the seed is an
 * upsert. `docker compose` runs this as a one-shot job before the web service
 * starts, so a fresh clone plus `docker compose up` yields a working board.
 */

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { closeDb, getDb } from "./client.js";
import { seedGlobalArena } from "./seed.js";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // `drizzle/` sits at the package root, one level above `dist/`.
  const migrationsFolder = join(here, "..", "drizzle");

  const db = getDb();
  console.log(`applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });

  const arena = await seedGlobalArena(db);
  console.log(`global arena ready: ${arena.slug} (${arena.id})`);
  console.log("migrations complete");
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error("migration failed:", err instanceof Error ? err.message : err);

    // Drizzle wraps a driver failure as "Failed query: ..." and hides the real
    // reason in `cause`. Without unwrapping it, a connection refused looks
    // identical to a genuine SQL error — which is a long detour when the
    // actual problem is a hostname.
    let cause: unknown = err instanceof Error ? err.cause : undefined;
    while (cause instanceof Error) {
      console.error("  caused by:", cause.message);
      cause = cause.cause;
    }

    const url = process.env.DATABASE_URL;
    if (url) {
      // Host and port only — never the password.
      try {
        const { hostname, port } = new URL(url);
        console.error(`  connecting to: ${hostname}:${port || 5432}`);
      } catch {
        console.error("  DATABASE_URL is not a parseable URL");
      }
    }

    await closeDb().catch(() => {});
    process.exit(1);
  });
