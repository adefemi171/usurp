/**
 * Efficiency signals and cohort normalization — `SPEC.md#4.2`.
 *
 * ── DEVIATION: `cache_ratio` is redefined ───────────────────────────────────
 * The spec proposes `cache_ratio = cache_read / (input + cache_read)`. Measured
 * against real Claude Code transcripts, `input_tokens` is only the *uncached
 * remainder* of a prompt and collapses to single digits on a warm cache, so
 * that expression pins to ~0.9999 for every competent user. A signal with no
 * variance cannot discriminate, and `w1` would be tuning pure noise.
 *
 * This uses `cache_read / (cache_read + cache_write)` instead: reuse measured
 * against re-caching, which is where the money actually goes. Cache writes cost
 * 1.25-2x the input rate; cache reads cost 0.1x. A user who keeps re-caching
 * the same context is burning real money, and this is the ratio that shows it.
 *
 * The rename is deliberate — `cacheReuse`, not `cacheRatio` — so nothing
 * silently keeps the old meaning.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** One day of a user's aggregated usage. The scoring engine's unit of input. */
export interface DailyMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  calls: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsAbandoned: number;
  editsApplied: number;
  editsReverted: number;
  commits: number;
}

/**
 * `#4.2` — input + output + cache_write. Cache reads are excluded because they
 * are ~10% of the input rate; counting them as volume is what rewards waste.
 */
export function effectiveTokens(m: DailyMetrics): number {
  return m.inputTokens + m.outputTokens + m.cacheWriteTokens;
}

export interface RawSignals {
  /**
   * `cache_read / (cache_read + cache_write)`. Reuse vs re-caching.
   * `null` when the user did no caching at all — see `zScores`.
   */
  cacheReuse: number | null;
  /** Commits per million effective tokens. Punishes burn-without-output. */
  yieldPerMTok: number | null;
  /** `sessions_completed / sessions_started`. Punishes abandoned thrash. */
  completion: number | null;
}

/**
 * Volume floor for the yield signal, in effective tokens.
 *
 * ── Why this exists (found by the `#4.4` harness) ───────────────────────────
 * `#4.2` defines `yield = merged_commits / effective_tokens`, which is
 * unbounded as tokens approach zero. Measured over a simulated cohort, the
 * `streak_farmer` archetype — ~1,074 effective tokens/day, whose entire
 * strategy is doing nothing — averaged **290.6 commits/MTok** against
 * `efficient_daily`'s **18.7**. A single commit on a near-empty day scores
 * ~930/MTok.
 *
 * Because z-scores are cohort-relative, that heavy tail inflated the cohort
 * mean and standard deviation and compressed every real user's yield z-score
 * toward zero. The signal designed to punish burn-without-output was captured
 * by the players with almost no burn.
 *
 * A floor bounds the ratio for trivial-volume days without touching anyone
 * real: `efficient_daily` runs ~550k effective tokens/day, five times the
 * floor, so its yield is unchanged.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const YIELD_VOLUME_FLOOR = 100_000;

export function rawSignals(m: DailyMetrics): RawSignals {
  const cacheTotal = m.cacheReadTokens + m.cacheWriteTokens;
  const effective = effectiveTokens(m);

  return {
    cacheReuse: cacheTotal > 0 ? m.cacheReadTokens / cacheTotal : null,
    // Divide by the floor, not the raw total — see `YIELD_VOLUME_FLOOR`.
    yieldPerMTok:
      effective > 0
        ? m.commits / (Math.max(effective, YIELD_VOLUME_FLOOR) / 1_000_000)
        : null,
    completion: m.sessionsStarted > 0 ? m.sessionsCompleted / m.sessionsStarted : null,
  };
}

export type SignalName = keyof RawSignals;

export const SIGNAL_NAMES: readonly SignalName[] = [
  "cacheReuse",
  "yieldPerMTok",
  "completion",
];

export interface SignalZScores {
  cacheReuse: number;
  yieldPerMTok: number;
  completion: number;
}

/**
 * Normalize each signal against the cohort — `#4.2`.
 *
 * Cohort-relative rather than absolute so a hobbyist is not scored against a
 * monorepo team. Two edge cases decide whether this is fair:
 *
 *   **zero variance** — everyone identical. Returns 0 for all, i.e. nobody is
 *   advantaged. The alternative (dividing by ~0) produces ±Infinity from noise.
 *
 *   **missing signal** — `null`, because the denominator was zero: no caching,
 *   no sessions, no tokens. Treated as the cohort mean (z = 0), *not* as zero
 *   the value. A user with no sessions has not demonstrated bad completion;
 *   scoring them as worst-in-cohort would punish a short day rather than a
 *   wasteful one, and would make "start a session and abandon it" strictly
 *   better than "don't start one".
 */
export function zScores(cohort: readonly RawSignals[]): SignalZScores[] {
  const stats = new Map<SignalName, { mean: number; sd: number }>();

  for (const name of SIGNAL_NAMES) {
    const values = cohort
      .map((s) => s[name])
      .filter((v): v is number => v !== null && Number.isFinite(v));

    if (values.length === 0) {
      stats.set(name, { mean: 0, sd: 0 });
      continue;
    }

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // Population SD: this is the whole cohort, not a sample from a larger one.
    const variance =
      values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
    stats.set(name, { mean, sd: Math.sqrt(variance) });
  }

  return cohort.map((signals) => {
    const out = {} as SignalZScores;
    for (const name of SIGNAL_NAMES) {
      const { mean, sd } = stats.get(name)!;
      const value = signals[name];
      out[name] = value === null || !Number.isFinite(value) || sd === 0
        ? 0
        : (value - mean) / sd;
    }
    return out;
  });
}

/** Clamp a z-score so one freak outlier cannot dominate the multiplier. */
export const Z_CLAMP = 3;

export function clampZ(z: number): number {
  return Math.max(-Z_CLAMP, Math.min(Z_CLAMP, z));
}
