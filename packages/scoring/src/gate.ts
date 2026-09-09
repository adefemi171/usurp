/**
 * The `SPEC.md#4.4` ship gate.
 *
 * > Ship condition: `whale_burner` does not place top-10%, and
 * > `streak_farmer`/`cache_gamer` do not place top-25%. If weights can't be
 * > tuned to satisfy that, the premise is wrong (see `#1`).
 *
 * The spec states the gate as three prohibitions. Taken literally, a weighting
 * that ranks *everyone* by coin flip would pass — the gamers would be scattered
 * rather than winning. So this also checks the positive claim `#4.4` actually
 * makes: that `efficient_daily` is the strategy that wins. A model where the
 * gamers lose but the intended behaviour does not win is not a rating model,
 * it is noise, and it would fail `#1`'s wedge just as surely.
 */

import type { ArchetypeName, } from "./archetypes.js";
import type { ArchetypeSummary, SimulationResult } from "./simulate.js";

/** No `whale_burner` in the top 10% of the field. */
export const WHALE_MAX_PERCENTILE = 0.1;
/** No `streak_farmer` or `cache_gamer` in the top 25%. */
export const GAMER_MAX_PERCENTILE = 0.25;

/**
 * The positive claim: `efficient_daily` must actually win.
 *
 * Required to hold the top of the board — its median must land in the better
 * half, and it must supply most of the top 10%.
 */
export const INTENDED_MEDIAN_MAX_PERCENTILE = 0.5;
export const INTENDED_MIN_SHARE_OF_TOP_10 = 0.5;

export interface GateCheck {
  name: string;
  /** What `#4.4` requires. */
  requirement: string;
  passed: boolean;
  /** The measured value, formatted for the report. */
  observed: string;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}

function find(summaries: readonly ArchetypeSummary[], name: ArchetypeName): ArchetypeSummary {
  const found = summaries.find((s) => s.archetype === name);
  if (!found) throw new Error(`archetype ${name} missing from simulation`);
  return found;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function evaluateGate(result: SimulationResult): GateResult {
  const { byArchetype, players } = result;

  const whale = find(byArchetype, "whale_burner");
  const streak = find(byArchetype, "streak_farmer");
  const cache = find(byArchetype, "cache_gamer");
  const intended = find(byArchetype, "efficient_daily");

  const topCount = Math.max(1, Math.round(players.length * 0.1));
  const top10 = players.slice(0, topCount);
  const intendedShareOfTop10 =
    top10.filter((p) => p.archetype === "efficient_daily").length / top10.length;

  const checks: GateCheck[] = [
    {
      name: "whale_burner excluded from the top 10%",
      requirement: `0 players below the ${pct(WHALE_MAX_PERCENTILE)} percentile`,
      passed: whale.inTop10Pct === 0,
      observed: `${whale.inTop10Pct} of ${whale.players} in top 10% (best ${pct(whale.bestPercentile)})`,
    },
    {
      name: "streak_farmer excluded from the top 25%",
      requirement: `0 players below the ${pct(GAMER_MAX_PERCENTILE)} percentile`,
      passed: streak.inTop25Pct === 0,
      observed: `${streak.inTop25Pct} of ${streak.players} in top 25% (best ${pct(streak.bestPercentile)})`,
    },
    {
      name: "cache_gamer excluded from the top 25%",
      requirement: `0 players below the ${pct(GAMER_MAX_PERCENTILE)} percentile`,
      passed: cache.inTop25Pct === 0,
      observed: `${cache.inTop25Pct} of ${cache.players} in top 25% (best ${pct(cache.bestPercentile)})`,
    },
    // The positive claim. Not in the spec's wording, but without it the gate
    // is satisfiable by a random ranking.
    {
      name: "efficient_daily ranks in the better half (median)",
      requirement: `median percentile <= ${pct(INTENDED_MEDIAN_MAX_PERCENTILE)}`,
      passed: intended.medianPercentile <= INTENDED_MEDIAN_MAX_PERCENTILE,
      observed: `median ${pct(intended.medianPercentile)}`,
    },
    {
      name: "efficient_daily dominates the top 10%",
      requirement: `>= ${pct(INTENDED_MIN_SHARE_OF_TOP_10)} of the top 10%`,
      passed: intendedShareOfTop10 >= INTENDED_MIN_SHARE_OF_TOP_10,
      observed: `${pct(intendedShareOfTop10)} of the top ${topCount}`,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
}

/** Render the gate result for a terminal. */
export function formatGateReport(result: SimulationResult, gate: GateResult): string {
  const lines: string[] = [];
  const { options } = result;

  lines.push("");
  lines.push("SPEC.md#4.4 — rating model ship gate");
  lines.push(
    `  ${options.players} players · ${options.seasons} seasons × ${options.seasonDays} days · seed ${options.seed}`,
  );
  lines.push(
    `  weights: cacheReuse=${options.weights.cacheReuse} yield=${options.weights.yieldPerMTok} completion=${options.weights.completion}`,
  );
  lines.push("");

  const header = [
    "archetype".padEnd(17),
    "mean pts".padStart(9),
    "median %ile".padStart(12),
    "best".padStart(7),
    "top10".padStart(6),
    "top25".padStart(6),
    "eff tokens".padStart(12),
    "commits".padStart(8),
  ].join("  ");
  lines.push(`  ${header}`);
  lines.push(`  ${"-".repeat(header.length)}`);

  for (const s of result.byArchetype) {
    lines.push(
      "  " +
        [
          s.archetype.padEnd(17),
          s.meanPoints.toFixed(1).padStart(9),
          pct(s.medianPercentile).padStart(12),
          pct(s.bestPercentile).padStart(7),
          String(s.inTop10Pct).padStart(6),
          String(s.inTop25Pct).padStart(6),
          Math.round(s.meanEffectiveTokens).toLocaleString().padStart(12),
          s.meanCommits.toFixed(1).padStart(8),
        ].join("  "),
    );
  }

  lines.push("");
  for (const check of gate.checks) {
    lines.push(`  ${check.passed ? "PASS" : "FAIL"}  ${check.name}`);
    lines.push(`        need: ${check.requirement}`);
    lines.push(`        got:  ${check.observed}`);
  }

  lines.push("");
  lines.push(
    gate.passed
      ? "  GATE PASSED — consistency x efficiency beats volume."
      : "  GATE FAILED — per SPEC.md#1, do not build M3 on this weighting.",
  );
  lines.push("");

  return lines.join("\n");
}
