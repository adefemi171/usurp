/**
 * Weight search — `SPEC.md#4.4`: "if weights can't be tuned to satisfy that,
 * the premise is wrong."
 *
 * A coarse grid search, not gradient descent. The point is not to find an
 * optimum but to answer a yes/no question: **does any weighting in a sane range
 * satisfy the gate?** A grid answers that honestly and is trivially auditable;
 * an optimiser would invite the suspicion that the result was fitted.
 *
 * Every candidate is scored against multiple seeds, because a weighting that
 * passes on one seed has told you about that seed.
 */

import { GAMER_MAX_PERCENTILE, WHALE_MAX_PERCENTILE, evaluateGate } from "./gate.js";
import { simulate } from "./simulate.js";
import type { Weights } from "./score.js";

export interface TuningOptions {
  players?: number;
  seasons?: number;
  /** Seeds each candidate must pass. */
  seeds?: number;
  /** Values tried for each weight. */
  grid?: number[];
}

export interface Candidate {
  weights: Weights;
  /** Seeds passed, out of those tried. */
  seedsPassed: number;
  seedsTried: number;
  /** Worst (highest) top-10% count for whale across seeds. */
  whaleInTop10: number;
  streakInTop25: number;
  cacheInTop25: number;
  /** Median percentile of `efficient_daily`, averaged across seeds. */
  intendedMedian: number;
  /**
   * Worst-case distance below the gate thresholds, in percentage points.
   *
   * The smallest gap between any gamer's best placement and the threshold it
   * must stay under, across all seeds. Positive = clears the gate with room;
   * near-zero = a knife-edge that a different seed will breach.
   */
  worstMarginPp: number;
}

export interface TuningResult {
  tried: number;
  passing: Candidate[];
  /** The passing candidate that ranks the intended archetype highest. */
  best?: Candidate;
  options: Required<TuningOptions>;
}

/** Coarse but wide: zero through a weight that saturates the multiplier alone. */
export const DEFAULT_GRID = [0, 0.05, 0.1, 0.15, 0.2, 0.3];

export function tuneWeights(options: TuningOptions = {}): TuningResult {
  const players = options.players ?? 500;
  const seasons = options.seasons ?? 3;
  const seeds = Math.max(1, options.seeds ?? 3);
  const grid = options.grid ?? DEFAULT_GRID;

  const passing: Candidate[] = [];
  let tried = 0;

  for (const cacheReuse of grid) {
    for (const yieldPerMTok of grid) {
      for (const completion of grid) {
        // All-zero weights make efficiency_mult a constant 1.0, which reduces
        // the model to pure volume — the thing `#4.1` says not to rank on.
        if (cacheReuse === 0 && yieldPerMTok === 0 && completion === 0) continue;

        const weights: Weights = { cacheReuse, yieldPerMTok, completion };
        tried++;

        let seedsPassed = 0;
        let whaleInTop10 = 0;
        let streakInTop25 = 0;
        let cacheInTop25 = 0;
        let intendedMedianSum = 0;
        let worstMargin = Number.POSITIVE_INFINITY;

        for (let i = 0; i < seeds; i++) {
          const result = simulate({
            players,
            seasons,
            weights,
            seed: 20260909 + i * 7919,
          });
          const gate = evaluateGate(result);
          if (gate.passed) seedsPassed++;

          const by = (name: string) =>
            result.byArchetype.find((s) => s.archetype === name)!;

          whaleInTop10 = Math.max(whaleInTop10, by("whale_burner").inTop10Pct);
          streakInTop25 = Math.max(streakInTop25, by("streak_farmer").inTop25Pct);
          cacheInTop25 = Math.max(cacheInTop25, by("cache_gamer").inTop25Pct);
          intendedMedianSum += by("efficient_daily").medianPercentile;

          // Distance from each threshold, in percentage points.
          worstMargin = Math.min(
            worstMargin,
            (by("whale_burner").bestPercentile - WHALE_MAX_PERCENTILE) * 100,
            (by("streak_farmer").bestPercentile - GAMER_MAX_PERCENTILE) * 100,
            (by("cache_gamer").bestPercentile - GAMER_MAX_PERCENTILE) * 100,
          );
        }

        const candidate: Candidate = {
          weights,
          seedsPassed,
          seedsTried: seeds,
          whaleInTop10,
          streakInTop25,
          cacheInTop25,
          intendedMedian: intendedMedianSum / seeds,
          worstMarginPp: worstMargin,
        };

        // Must pass every seed, not most of them.
        if (seedsPassed === seeds) passing.push(candidate);
      }
    }
  }

  /**
   * Rank by **margin**, then by how high the intended archetype places.
   *
   * Ranking by placement alone recommended `cache=0, yield=0.05,
   * completion=0.2` from a 3-seed search — which then breached the gate by
   * 1.8pp on 2 of 8 seeds. Passing every seed in the search is necessary but
   * not sufficient; a weighting that only just clears is one unseen seed away
   * from failing, and this is a go/no-go decision.
   */
  passing.sort(
    (a, b) =>
      b.worstMarginPp - a.worstMarginPp ||
      a.intendedMedian - b.intendedMedian ||
      sumWeights(a.weights) - sumWeights(b.weights),
  );

  return {
    tried,
    passing,
    ...(passing[0] ? { best: passing[0] } : {}),
    options: { players, seasons, seeds, grid },
  };
}

function sumWeights(w: Weights): number {
  return w.cacheReuse + w.yieldPerMTok + w.completion;
}

export function formatTuningReport(result: TuningResult): string {
  const lines: string[] = [];
  const { options } = result;

  lines.push("");
  lines.push("SPEC.md#4.4 — weight search");
  lines.push(
    `  ${result.tried} weightings x ${options.seeds} seeds x ${options.players} players x ${options.seasons} seasons`,
  );
  lines.push(`  grid: ${options.grid.join(", ")}`);
  lines.push("");

  if (result.passing.length === 0) {
    lines.push("  NO WEIGHTING PASSED THE GATE.");
    lines.push("");
    lines.push("  Per SPEC.md#1 and #4.4 this is the kill signal: the premise that");
    lines.push("  consistency x efficiency can beat volume is not supported by the");
    lines.push("  current model. Do not proceed to M3.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`  ${result.passing.length} of ${result.tried} weightings passed every seed.`);
  lines.push("");

  const header = [
    "cache".padStart(6),
    "yield".padStart(6),
    "compl".padStart(6),
    "margin".padStart(9),
    "intended median %ile".padStart(21),
  ].join("  ");
  lines.push(`  ${header}`);
  lines.push(`  ${"-".repeat(header.length)}`);

  for (const c of result.passing.slice(0, 12)) {
    lines.push(
      "  " +
        [
          String(c.weights.cacheReuse).padStart(6),
          String(c.weights.yieldPerMTok).padStart(6),
          String(c.weights.completion).padStart(6),
          `+${c.worstMarginPp.toFixed(1)}pp`.padStart(9),
          `${(c.intendedMedian * 100).toFixed(1)}%`.padStart(21),
        ].join("  "),
    );
  }

  const best = result.best!;
  lines.push("");
  lines.push("  Recommended:");
  lines.push(
    `    cacheReuse=${best.weights.cacheReuse} yieldPerMTok=${best.weights.yieldPerMTok} completion=${best.weights.completion}`,
  );
  lines.push(
    `    efficient_daily median percentile ${(best.intendedMedian * 100).toFixed(1)}%`,
  );
  lines.push(
    `    worst-case margin below the gate thresholds: +${best.worstMarginPp.toFixed(1)}pp`,
  );
  lines.push("");

  return lines.join("\n");
}
