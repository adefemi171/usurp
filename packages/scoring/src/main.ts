#!/usr/bin/env node
/**
 * `npm run simulate` — run the `SPEC.md#4.4` ship gate.
 *
 * Exits non-zero when the gate fails, so it can be a CI check: shipping M3 on
 * a weighting that fails this is the failure mode `#1` says to kill the project
 * over.
 *
 *   npm run simulate                          # default weights
 *   npm run simulate -- --tune                # search for a passing weighting
 *   npm run simulate -- --seeds 5             # check robustness across seeds
 *   npm run simulate -- --cache 0.2 --yield 0.1 --completion 0.05
 */

import { DEFAULT_WEIGHTS, type Weights } from "./score.js";
import { evaluateGate, formatGateReport } from "./gate.js";
import { simulate } from "./simulate.js";
import { tuneWeights, formatTuningReport } from "./tune.js";

function numberFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function main(): number {
  const seeds = Math.max(1, Math.round(numberFlag("seeds", 1)));
  const players = Math.round(numberFlag("players", 500));
  const seasons = Math.round(numberFlag("seasons", 3));

  if (hasFlag("tune")) {
    const tuning = tuneWeights({ players, seasons, seeds });
    process.stdout.write(formatTuningReport(tuning));
    return tuning.best ? 0 : 1;
  }

  const weights: Weights = {
    cacheReuse: numberFlag("cache", DEFAULT_WEIGHTS.cacheReuse),
    yieldPerMTok: numberFlag("yield", DEFAULT_WEIGHTS.yieldPerMTok),
    completion: numberFlag("completion", DEFAULT_WEIGHTS.completion),
  };

  let allPassed = true;

  for (let i = 0; i < seeds; i++) {
    // Distinct, deterministic seeds: a gate that passes only on one seed has
    // told you about that seed, not about the model.
    const seed = 20260909 + i * 7919;
    const result = simulate({ players, seasons, weights, seed });
    const gate = evaluateGate(result);
    if (!gate.passed) allPassed = false;

    process.stdout.write(formatGateReport(result, gate));
  }

  if (seeds > 1) {
    process.stdout.write(
      `  ${allPassed ? "ALL" : "NOT ALL"} ${seeds} seeds passed.\n\n`,
    );
  }

  return allPassed ? 0 : 1;
}

process.exit(main());
