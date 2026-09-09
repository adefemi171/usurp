#!/usr/bin/env node
/**
 * `npm run worker` — the background job process.
 *
 * A separate process from the web server on purpose. A recompute is
 * CPU-and-IO-heavy and periodic; sharing the web process would make every
 * board request compete with it, and would run N copies of every job behind a
 * load balancer.
 */

import { closeDb } from "./client.js";
import { startWorker } from "./jobs.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const recomputeCron = flag("recompute-cron");
  const maintenanceCron = flag("maintenance-cron");

  const worker = await startWorker({
    ...(recomputeCron ? { recomputeCron } : {}),
    ...(maintenanceCron ? { maintenanceCron } : {}),
    // A fresh container should not serve a stale board for a full interval.
    runOnStart: !process.argv.includes("--no-run-on-start"),
  });

  console.log("worker started; ctrl-c to stop");

  let stopping = false;
  const shutdown = async (signal: string) => {
    // A second signal during a graceful stop should not start a second one.
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} — finishing in-flight jobs…`);
    try {
      await worker.stop();
      await closeDb();
    } catch (err) {
      console.error("shutdown failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch(async (err: unknown) => {
  console.error("worker failed to start:", err instanceof Error ? err.message : err);
  let cause: unknown = err instanceof Error ? err.cause : undefined;
  while (cause instanceof Error) {
    console.error("  caused by:", cause.message);
    cause = cause.cause;
  }
  await closeDb().catch(() => {});
  process.exit(1);
});
