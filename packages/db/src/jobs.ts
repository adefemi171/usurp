/**
 * Background jobs — `SPEC.md#8` ("Jobs | pg-boss | Season rollover, daily
 * decay, circle shrink, duel settlement").
 *
 * ── Why the rating recompute lives here and not in ingest ───────────────────
 * `#6.1` describes the recompute as happening "on ingest". That holds for the
 * standings half but not for `daily_scores`: z-scores are cohort-relative, so
 * one late bucket from one user shifts the cohort mean for that day and changes
 * *every other user's* score for it. A correct recompute is inherently
 * O(active users × affected days), which cannot sit inside the HTTP request a
 * `SessionEnd` hook is waiting on.
 *
 * So ingest stays fast and this runs on a schedule. pg-boss keeps its state in
 * the same Postgres, so there is no second piece of infrastructure to run —
 * which matters for `#8`'s "single docker-compose.yml" self-host promise.
 */

// pg-boss 12 exports the class as a named export, not a default.
import { PgBoss } from "pg-boss";
import { getDb } from "./client.js";
import { databaseTransport } from "./transport.js";
import { arenas } from "./schema.js";
import { recomputeDailyScores, recomputeStandings } from "./rating.js";
import { applyCircles } from "./circles.js";
import { settleDuels } from "./duels.js";
import { addDays, closeElapsedSeasons, ensureCurrentSeason, startOfUtcDay } from "./seasons.js";
import { pruneSessions } from "./auth.js";
import { pruneEnrollments } from "./enrollment.js";
import { dispatchNotifications, pruneDeliveries } from "./notifications.js";

// Hyphens, not colons: pg-boss restricts queue names to alphanumerics,
// underscores, hyphens, periods and forward slashes, and rejects the rest at
// startup with "Name can only contain...".
export const QUEUE_RECOMPUTE = "rating-recompute";
export const QUEUE_MAINTENANCE = "usurp-maintenance";

/**
 * How far back a scheduled recompute reaches.
 *
 * A season plus a week of slack, so `#6.2`'s offline laptop — which may submit
 * days-old buckets — still lands inside a window that gets rebuilt.
 */
export const RECOMPUTE_WINDOW_DAYS = 35;

export interface RecomputeSummary {
  dailyRows: number;
  days: number;
  users: number;
  arenas: number;
  usurpings: Array<{ arena: string; actorId: string; targetId: string | null }>;
  /** `#5.2` eliminations applied this run. */
  eliminations: Array<{ arena: string; cuts: number[]; handles: string[] }>;
}

/**
 * Rebuild `daily_scores` then every arena's standings.
 *
 * Exported separately from the job wrapper so the script and the tests can run
 * exactly the same code path the scheduler does.
 */
export async function runRecompute(
  options: { days?: number; now?: Date } = {},
): Promise<RecomputeSummary> {
  const now = options.now ?? new Date();
  const days = options.days ?? RECOMPUTE_WINDOW_DAYS;
  const db = getDb();

  const from = addDays(startOfUtcDay(now), -days);
  const to = addDays(startOfUtcDay(now), 1);

  const daily = await recomputeDailyScores(db, from, to);

  const allArenas = await db.select().from(arenas);
  const usurpings: RecomputeSummary["usurpings"] = [];
  const eliminations: RecomputeSummary["eliminations"] = [];

  for (const arena of allArenas) {
    const season = await ensureCurrentSeason(db, arena.id, now);
    const result = await recomputeStandings(db, arena.id, season, now);
    if (result.usurped) {
      usurpings.push({ arena: arena.slug, ...result.usurped });
    }

    /**
     * Circles run **after** standings, not before.
     *
     * A cut comes off the bottom of the current ranking, so it needs ranks
     * already written. The ordering is safe in the other direction too: a
     * bottom cut can never remove the leader, so the reign decided a moment
     * ago cannot be invalidated by the elimination that follows it.
     */
    const circles = await applyCircles(db, arena.id, season, now);
    if (circles.eliminated.length > 0) {
      eliminations.push({
        arena: arena.slug,
        cuts: circles.applied,
        handles: circles.eliminated.map((e) => e.handle),
      });
    }
  }

  return {
    dailyRows: daily.rows,
    days: daily.days,
    users: daily.users,
    arenas: allArenas.length,
    usurpings,
    eliminations,
  };
}

export interface MaintenanceSummary {
  seasonsClosed: number;
  sessionsPruned: number;
  duelsSettled: number;
  deliveriesPruned: number;
}

/** Housekeeping: close elapsed seasons, drop expired sessions and codes. */
export async function runMaintenance(
  options: { now?: Date } = {},
): Promise<MaintenanceSummary> {
  const now = options.now ?? new Date();
  const db = getDb();

  const seasonsClosed = await closeElapsedSeasons(db, now);
  const sessionsPruned = await pruneSessions(db, now);
  await pruneEnrollments(db, now);
  // `#8` lists duel settlement as a job; a duel window closes on a clock, not
  // in response to a request.
  const settled = await settleDuels(db, { now });
  const deliveriesPruned = await pruneDeliveries(db, now);

  return {
    seasonsClosed,
    sessionsPruned,
    duelsSettled: settled.length,
    deliveriesPruned,
  };
}

export interface WorkerOptions {
  /** Cron for the recompute. Default: every 10 minutes. */
  recomputeCron?: string;
  /** Cron for housekeeping. Default: 03:17 UTC daily. */
  maintenanceCron?: string;
  /** Run each job once at startup, so a fresh deploy is not stale for 10 minutes. */
  runOnStart?: boolean;
}

export interface Worker {
  boss: PgBoss;
  stop(): Promise<void>;
}

/**
 * Start the worker.
 *
 * Both queues are `singletonKey`-guarded so a second instance cannot run a
 * recompute concurrently with the first. That is belt-and-braces — the
 * standings write already takes `#6.1`'s per-arena advisory lock — but a
 * duplicate recompute is pure wasted work even when it is safe.
 */
export async function startWorker(options: WorkerOptions = {}): Promise<Worker> {
  const recomputeCron = options.recomputeCron ?? "*/10 * * * *";
  const maintenanceCron = options.maintenanceCron ?? "17 3 * * *";

  const boss = new PgBoss({ ...databaseTransport(), max: Number(process.env.DATABASE_WORKER_POOL_MAX ?? 3) });

  // Surface pg-boss's own failures rather than letting them vanish: an
  // EventEmitter with no `error` listener throws and takes the process down.
  boss.on("error", (err: unknown) => console.error("[pg-boss]", err));

  await boss.start();

  // pg-boss 10+ requires queues to exist before send/work/schedule.
  await boss.createQueue(QUEUE_RECOMPUTE);
  await boss.createQueue(QUEUE_MAINTENANCE);

  await boss.work(QUEUE_RECOMPUTE, async () => {
    const started = Date.now();
    // Settle first: a duel that closed since the last pass should have its
    // winnings in `duel_pts` before the replay reads them back.
    const settled = await settleDuels(getDb());
    if (settled.length > 0) console.log(`[recompute] settled ${settled.length} duel(s)`);
    const summary = await runRecompute();
    console.log(
      `[recompute] ${summary.dailyRows} daily rows / ${summary.users} users / ` +
        `${summary.arenas} arenas in ${Date.now() - started}ms`,
    );
    for (const u of summary.usurpings) {
      console.log(`[recompute] throne changed in ${u.arena}`);
    }
    for (const e of summary.eliminations) {
      console.log(
        `[recompute] circle ${e.cuts.join(",")} in ${e.arena}: ${e.handles.length} eliminated`,
      );
    }

    /**
     * Notifications ride the recompute rather than a queue of their own.
     *
     * The recompute is the only thing that *creates* a throne change, so
     * dispatching immediately after it is the shortest path from "you were
     * usurped" to the alert — and it means one schedule to reason about. A
     * dead webhook cannot stall the board either: delivery failures are
     * recorded per channel, never thrown.
     */
    try {
      const notified = await dispatchNotifications(getDb());
      if (notified.sent + notified.failed + notified.suppressed > 0) {
        console.log(
          `[notify] ${notified.sent} sent, ${notified.suppressed} suppressed, ` +
            `${notified.failed} failed (of ${notified.considered} events)`,
        );
      }
    } catch (err) {
      console.error("[notify] dispatch failed", err);
    }
  });

  await boss.work(QUEUE_MAINTENANCE, async () => {
    const summary = await runMaintenance();
    console.log(
      `[maintenance] ${summary.seasonsClosed} seasons closed, ` +
        `${summary.sessionsPruned} sessions pruned, ` +
        `${summary.duelsSettled} duels settled, ` +
        `${summary.deliveriesPruned} delivery rows pruned`,
    );
  });

  await boss.schedule(QUEUE_RECOMPUTE, recomputeCron);
  await boss.schedule(QUEUE_MAINTENANCE, maintenanceCron);

  if (options.runOnStart) {
    // A deploy should not serve a stale board for a whole cron interval.
    await boss.send(QUEUE_RECOMPUTE, {});
    await boss.send(QUEUE_MAINTENANCE, {});
  }

  return {
    boss,
    async stop() {
      // `graceful` lets in-flight jobs finish; a recompute killed mid-write
      // would leave standings and reigns disagreeing.
      await boss.stop({ graceful: true });
    },
  };
}
