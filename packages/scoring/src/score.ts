/**
 * The rating engine — `SPEC.md#4.2`, `#4.3`.
 *
 *   points(day)      = volume_pts × efficiency_mult × streak_mult
 *   volume_pts       = 10 × log10(1 + effective_tokens / 1000)
 *   efficiency_mult  = clamp(0.5, 2.0, 1 + Σ wᵢ·zᵢ)          ← see DEVIATION
 *   streak_mult      = min(1.25, 1 + 0.03 × consecutive_active_days)
 *
 * ── DEVIATION: `efficiency_mult` needs a centre ─────────────────────────────
 * The spec writes `clamp(0.5, 2.0, w1·z1 + w2·z2 + w3·z3)`. Z-scores are
 * centered on zero by construction, so that expression gives the *median*
 * player the multiplier floor:
 *
 *     z = (0,0,0)   -> 0.500      ← median player, minimum multiplier
 *     z = (-1,-1,-1) -> 0.500     ← indistinguishable from median
 *     z = (+1,+1,+1) -> 1.000
 *     z = (+2,+2,+2) -> 2.000
 *
 * Everyone at or below average is pinned at the floor, so the multiplier cannot
 * discriminate across the entire bottom half of the cohort — and the "average"
 * player is penalised as hard as the worst. Adding the `1 +` centre makes the
 * median neutral (1.0), which is what a multiplier bounded by [0.5, 2.0]
 * plainly intends.
 * ────────────────────────────────────────────────────────────────────────────
 */

import {
  clampZ,
  effectiveTokens,
  rawSignals,
  zScores,
  type DailyMetrics,
  type SignalZScores,
} from "./signals.js";

/** `#4.2` bounds on the efficiency multiplier. */
export const EFFICIENCY_MIN = 0.5;
export const EFFICIENCY_MAX = 2.0;

/** `#4.2` streak: +3% per consecutive active day, capped at +25%. */
export const STREAK_STEP = 0.03;
export const STREAK_MAX = 1.25;

/** `#4.3` — seasonal points decay 5% per day of inactivity. */
export const DECAY_PER_INACTIVE_DAY = 0.05;

export interface Weights {
  cacheReuse: number;
  yieldPerMTok: number;
  completion: number;
}

/**
 * Weights selected by the `#4.4` harness, not by taste.
 *
 * Yield-led on purpose: commits per effective token is the only signal that
 * actually distinguishes *doing work* from *burning tokens*, and it is the one
 * the `cache_gamer` cannot fake without doing the work. `completion` is a
 * secondary check on thrash; `cacheReuse` is a small penalty-only term that
 * catches the re-cacher (see `cacheReuseContribution`).
 *
 * Chosen for **margin**, not just for passing. Measured over 8 seeds:
 *
 *     cache  yield  compl   seeds passed   worst cache_gamer margin
 *     0.05   0.20   0.10        8/8              +6.1pp
 *     0.10   0.10   0.10        8/8              +0.5pp   knife-edge
 *     0.00   0.05   0.20        6/8              -1.8pp   breaches the gate
 *
 * The third row is what a 3-seed search recommended, which is why
 * `tuneWeights` now ranks by worst-case margin.
 */
export const DEFAULT_WEIGHTS: Weights = {
  cacheReuse: 0.05,
  yieldPerMTok: 0.2,
  completion: 0.1,
};

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function volumePoints(m: DailyMetrics): number {
  // Log-scaled: 10x the tokens is +10 points, so volume alone cannot run away.
  return 10 * Math.log10(1 + effectiveTokens(m) / 1000);
}

/**
 * `cacheReuse` contributes as a penalty only — `min(0, z)`.
 *
 * ── Why (found by the `#4.4` harness) ───────────────────────────────────────
 * Measured across a simulated cohort, the raw signal ranks the gamer *above*
 * the intended player:
 *
 *     cache_gamer      0.9992   <- maximises read, writes almost nothing
 *     sporadic_genius  0.9741
 *     efficient_daily  0.9626   <- the behaviour we want to reward
 *     streak_farmer    0.9370
 *     whale_burner     0.6301   <- constantly re-caching, the real waste
 *
 * It separates the whale cleanly, but among well-behaved users it is inverted:
 * a high ratio is achieved by *not writing cache*, which is what someone with
 * nothing to do looks like. So any positive weight on it actively helps the
 * gamer beat the honest user.
 *
 * Treating it as penalty-only keeps the part that works — punishing the
 * re-cacher — and removes the part that is farmable. The principle: high cache
 * reuse is evidence of the *absence of waste*, not of the *presence of skill*.
 * You should not be able to earn rating by not working.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function cacheReuseContribution(z: number): number {
  return Math.min(0, clampZ(z));
}

export function efficiencyMultiplier(z: SignalZScores, weights: Weights): number {
  const weighted =
    weights.cacheReuse * cacheReuseContribution(z.cacheReuse) +
    weights.yieldPerMTok * clampZ(z.yieldPerMTok) +
    weights.completion * clampZ(z.completion);

  // The `1 +` is the deviation documented above.
  return clamp(EFFICIENCY_MIN, EFFICIENCY_MAX, 1 + weighted);
}

export function streakMultiplier(consecutiveActiveDays: number): number {
  return Math.min(STREAK_MAX, 1 + STREAK_STEP * Math.max(0, consecutiveActiveDays));
}

export interface DailyScore {
  volumePts: number;
  efficiencyMult: number;
  streakMult: number;
  points: number;
}

export function dailyScore(
  m: DailyMetrics,
  z: SignalZScores,
  consecutiveActiveDays: number,
  weights: Weights = DEFAULT_WEIGHTS,
): DailyScore {
  const volumePts = volumePoints(m);
  const efficiencyMult = efficiencyMultiplier(z, weights);
  const streakMult = streakMultiplier(consecutiveActiveDays);

  return {
    volumePts,
    efficiencyMult,
    streakMult,
    points: volumePts * efficiencyMult * streakMult,
  };
}

/** A day is "active" if any billable work happened. */
export function isActive(m: DailyMetrics): boolean {
  return effectiveTokens(m) > 0 || m.calls > 0;
}

/**
 * Score a cohort for one day.
 *
 * Takes the whole cohort at once because z-scores are cohort-relative — a
 * single user's daily score is not defined in isolation, which is also why
 * `#6` computes `daily_scores` globally and treats arenas as views over it.
 */
export function scoreCohortDay(
  cohort: readonly { metrics: DailyMetrics; consecutiveActiveDays: number }[],
  weights: Weights = DEFAULT_WEIGHTS,
): DailyScore[] {
  const zs = zScores(cohort.map((c) => rawSignals(c.metrics)));
  return cohort.map((c, i) =>
    dailyScore(c.metrics, zs[i]!, c.consecutiveActiveDays, weights),
  );
}

export interface SeasonState {
  /** Accumulated seasonal points, after decay. */
  points: number;
  /** Current consecutive-active-day run. */
  streak: number;
  activeDays: number;
  inactiveDays: number;
  /** Sum of daily points before decay, for diagnostics. */
  grossPoints: number;
}

export function newSeasonState(): SeasonState {
  return { points: 0, streak: 0, activeDays: 0, inactiveDays: 0, grossPoints: 0 };
}

/**
 * Advance one day of a season.
 *
 * `#4.3` — "seasonal points decay 5%/day of inactivity. Standing still is
 * falling." Decay applies to the accumulated total on an inactive day, and the
 * streak resets. This is the mechanic that stops a champion banking a win and
 * coasting, so it is deliberately multiplicative on the running total rather
 * than a flat subtraction: a large lead decays faster in absolute terms, which
 * is what makes a throne contestable.
 */
export function advanceDay(
  state: SeasonState,
  metrics: DailyMetrics,
  z: SignalZScores,
  weights: Weights = DEFAULT_WEIGHTS,
): SeasonState {
  if (!isActive(metrics)) {
    return {
      points: state.points * (1 - DECAY_PER_INACTIVE_DAY),
      streak: 0,
      activeDays: state.activeDays,
      inactiveDays: state.inactiveDays + 1,
      grossPoints: state.grossPoints,
    };
  }

  const streak = state.streak + 1;
  // The streak multiplier uses the run *including* today, so a first active day
  // gets 1.03 rather than 1.0 — consistent with "consecutive active days".
  const score = dailyScore(metrics, z, streak, weights);

  return {
    points: state.points + score.points,
    streak,
    activeDays: state.activeDays + 1,
    inactiveDays: state.inactiveDays,
    grossPoints: state.grossPoints + score.points,
  };
}
