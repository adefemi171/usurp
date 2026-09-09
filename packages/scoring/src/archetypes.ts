/**
 * Synthetic player archetypes — `SPEC.md#4.4`.
 *
 * The five the spec names, each built to attack a different part of the scoring
 * formula. The point is adversarial: if a weighting lets any of the three
 * gamers place well, the rating model is farmable and `#1` says kill the
 * project rather than ship it.
 *
 * Every archetype stays inside `#3.4`'s plausibility gates. A cheater who
 * submits impossible numbers is already handled by ingest — the interesting
 * threat is someone whose data is entirely *real* and still games the ranking.
 */

import { contextWindowFor } from "@usurp/protocol";
import type { DailyMetrics } from "./signals.js";

export type ArchetypeName =
  | "whale_burner"
  | "efficient_daily"
  | "sporadic_genius"
  | "streak_farmer"
  | "cache_gamer";

export const ARCHETYPE_NAMES: readonly ArchetypeName[] = [
  "whale_burner",
  "efficient_daily",
  "sporadic_genius",
  "streak_farmer",
  "cache_gamer",
];

/**
 * Deterministic PRNG (mulberry32).
 *
 * A simulation that decides a go/no-go must be reproducible: `Math.random()`
 * would make the ship gate pass on one run and fail on the next, and nobody
 * could tell whether a weight change or the seed moved the result.
 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [lo, hi). */
function uniform(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Box-Muller, so per-player variation is not uniformly flat. */
function normal(rng: () => number, mean: number, sd: number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const MODEL = "claude-opus-5";

export interface DayContext {
  /** 0-indexed day within the season. */
  day: number;
  rng: () => number;
}

/** An empty day. Returned by every archetype on days it does not work. */
export function idleDay(): DailyMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    sessionsAbandoned: 0,
    editsApplied: 0,
    editsReverted: 0,
    commits: 0,
  };
}

/**
 * Build a day from intent, keeping it inside the plausibility gates.
 *
 * `cache_read` per call is capped at the model's context window, so no
 * archetype can claim to have read more context than the model can hold —
 * exactly the ceiling `#3.4` enforces at ingest.
 */
function buildDay(input: {
  calls: number;
  outputPerCall: number;
  cacheReadPerCall: number;
  cacheWritePerCall: number;
  sessions: number;
  completionRate: number;
  commits: number;
  edits: number;
}): DailyMetrics {
  const window = contextWindowFor(MODEL);
  const calls = Math.max(0, Math.round(input.calls));
  if (calls === 0) return idleDay();

  // Keep total per-call input under the context window.
  const cacheRead = Math.min(input.cacheReadPerCall, window * 0.9);
  const cacheWrite = Math.min(input.cacheWritePerCall, window * 0.05);

  const sessionsStarted = Math.max(1, Math.round(input.sessions));
  const sessionsCompleted = Math.round(sessionsStarted * input.completionRate);

  return {
    // Real transcripts show single-digit uncached input on a warm cache.
    inputTokens: calls * 2,
    outputTokens: Math.round(calls * input.outputPerCall),
    cacheWriteTokens: Math.round(calls * cacheWrite),
    cacheReadTokens: Math.round(calls * cacheRead),
    calls,
    sessionsStarted,
    sessionsCompleted,
    sessionsAbandoned: sessionsStarted - sessionsCompleted,
    editsApplied: Math.round(input.edits),
    editsReverted: Math.round(input.edits * 0.05),
    commits: Math.max(0, Math.round(input.commits)),
  };
}

export interface Archetype {
  name: ArchetypeName;
  /** One-line description of what it is attacking. */
  attacks: string;
  day(ctx: DayContext, player: PlayerTraits): DailyMetrics;
}

/** Per-player variation, so 100 copies of an archetype are not identical. */
export interface PlayerTraits {
  scale: number;
  diligence: number;
}

export function makeTraits(rng: () => number): PlayerTraits {
  return {
    scale: Math.max(0.3, normal(rng, 1, 0.25)),
    diligence: Math.min(1, Math.max(0, normal(rng, 0.5, 0.2))),
  };
}

const ARCHETYPES: Record<ArchetypeName, Archetype> = {
  /**
   * Enormous volume, poor everything else. The incumbent behaviour `#4.1` says
   * every competitor rewards, and the one this model must not.
   */
  whale_burner: {
    name: "whale_burner",
    attacks: "raw volume — the strategy every token leaderboard rewards",
    day({ rng }, traits) {
      // Works most days, enormously, and thrashes: low reuse, few commits,
      // many abandoned sessions.
      if (rng() < 0.15) return idleDay();
      return buildDay({
        calls: uniform(rng, 900, 1600) * traits.scale,
        outputPerCall: uniform(rng, 900, 1800),
        // Constantly re-caching: a big write share is the signature.
        cacheReadPerCall: uniform(rng, 20_000, 45_000),
        cacheWritePerCall: uniform(rng, 12_000, 26_000),
        sessions: uniform(rng, 12, 25),
        completionRate: uniform(rng, 0.2, 0.45),
        commits: uniform(rng, 0, 2),
        edits: uniform(rng, 30, 80),
      });
    },
  },

  /**
   * Moderate volume, every day, done well. `#4.4`'s claim is that this beats
   * the whale.
   */
  efficient_daily: {
    name: "efficient_daily",
    attacks: "nothing — this is the behaviour the model is supposed to reward",
    day({ rng }, traits) {
      if (rng() < 0.08) return idleDay();
      return buildDay({
        calls: uniform(rng, 120, 300) * traits.scale,
        outputPerCall: uniform(rng, 700, 1400),
        // Warm cache, rarely re-caching.
        cacheReadPerCall: uniform(rng, 25_000, 60_000),
        cacheWritePerCall: uniform(rng, 600, 2500),
        sessions: uniform(rng, 3, 7),
        completionRate: uniform(rng, 0.85, 1),
        commits: uniform(rng, 4, 12),
        edits: uniform(rng, 20, 50),
      });
    },
  },

  /** Excellent work, rarely. Tests whether `#4.3`'s decay bites. */
  sporadic_genius: {
    name: "sporadic_genius",
    attacks: "decay — high quality but absent most of the season",
    day({ rng }, traits) {
      // Roughly two active days a week.
      if (rng() > 0.3) return idleDay();
      return buildDay({
        calls: uniform(rng, 200, 450) * traits.scale,
        outputPerCall: uniform(rng, 900, 1600),
        cacheReadPerCall: uniform(rng, 30_000, 70_000),
        cacheWritePerCall: uniform(rng, 500, 2000),
        sessions: uniform(rng, 2, 5),
        completionRate: uniform(rng, 0.9, 1),
        commits: uniform(rng, 6, 16),
        edits: uniform(rng, 25, 60),
      });
    },
  },

  /**
   * The minimum possible activity, every single day, purely to hold the streak
   * multiplier at its 1.25 ceiling.
   */
  streak_farmer: {
    name: "streak_farmer",
    attacks: "streak_mult — one token a day to pin the multiplier at 1.25",
    day({ rng }, traits) {
      // Never idle. That is the entire strategy.
      return buildDay({
        calls: uniform(rng, 1, 4) * traits.scale,
        outputPerCall: uniform(rng, 50, 200),
        cacheReadPerCall: uniform(rng, 2000, 8000),
        cacheWritePerCall: uniform(rng, 100, 500),
        sessions: 1,
        completionRate: 1,
        commits: rng() < 0.2 ? 1 : 0,
        edits: uniform(rng, 0, 2),
      });
    },
  },

  /**
   * Inflates the cache-reuse signal specifically.
   *
   * This is the archetype that decides `w1`. It keeps `cache_write` near zero
   * and `cache_read` near the context window, so `cacheReuse` approaches 1.0 —
   * a perfect score on that signal — while producing almost nothing. If
   * `cacheReuse` is weighted too heavily, this player wins, and the signal is
   * farmable exactly the way the spec's original `cache_ratio` was.
   */
  cache_gamer: {
    name: "cache_gamer",
    attacks: "the cache signal — near-perfect reuse, almost no output",
    day({ rng }, traits) {
      if (rng() < 0.1) return idleDay();
      return buildDay({
        calls: uniform(rng, 150, 400) * traits.scale,
        outputPerCall: uniform(rng, 100, 300),
        // Maximal read, minimal write: reuse ratio ~0.99.
        cacheReadPerCall: uniform(rng, 60_000, 120_000),
        cacheWritePerCall: uniform(rng, 20, 120),
        sessions: uniform(rng, 2, 4),
        // Completes sessions too — it is gaming, not obviously broken.
        completionRate: uniform(rng, 0.9, 1),
        commits: rng() < 0.25 ? 1 : 0,
        edits: uniform(rng, 1, 5),
      });
    },
  },
};

export function getArchetype(name: ArchetypeName): Archetype {
  return ARCHETYPES[name];
}

export function allArchetypes(): readonly Archetype[] {
  return ARCHETYPE_NAMES.map(getArchetype);
}
