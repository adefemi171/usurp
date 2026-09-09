#!/usr/bin/env node
/**
 * `npm run recompute` — run the rating recompute once, now.
 *
 * The same code path the scheduled job uses (`runRecompute` in `jobs.ts`), so
 * a manual run and a scheduled one cannot diverge. Useful for a first import,
 * for a backfill after changing weights, and in tests.
 *
 * For continuous operation use `npm run worker`, which runs this on a cron.
 */

import { closeDb } from "./client.js";
import { RECOMPUTE_WINDOW_DAYS, runMaintenance, runRecompute } from "./jobs.js";

function numberFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

async function main(): Promise<void> {
  const days = Math.max(1, Math.round(numberFlag("days", RECOMPUTE_WINDOW_DAYS)));

  console.log(`recomputing the last ${days} days`);
  const summary = await runRecompute({ days });

  console.log(
    `  daily_scores: ${summary.dailyRows} rows across ${summary.days} days for ${summary.users} users`,
  );
  console.log(`  standings:    ${summary.arenas} arena(s)`);

  for (const u of summary.usurpings) {
    console.log(`  THRONE CHANGED in ${u.arena}${u.targetId ? "" : " (first sovereign)"}`);
  }

  for (const e of summary.eliminations) {
    console.log(
      `  CIRCLE ${e.cuts.join(",")} in ${e.arena}: eliminated ${e.handles.join(", ")}`,
    );
  }

  if (process.argv.includes("--maintenance")) {
    const m = await runMaintenance();
    console.log(`  maintenance:  ${m.seasonsClosed} seasons closed, ${m.sessionsPruned} sessions pruned`);
  }
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error("recompute failed:", err instanceof Error ? err.message : err);
    let cause: unknown = err instanceof Error ? err.cause : undefined;
    while (cause instanceof Error) {
      console.error("  caused by:", cause.message);
      cause = cause.cause;
    }
    const url = process.env.DATABASE_URL;
    if (url) {
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
