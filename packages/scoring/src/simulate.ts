/**
 * The `SPEC.md#4.4` simulation harness.
 *
 * 500 synthetic players across five archetypes, run over three simulated
 * seasons. This exists to answer one question before any of M2 is built on top
 * of it: **can any weighting make consistency × efficiency beat volume?** If
 * not, `#1` says kill the project rather than ship a reskin of ccclub.
 *
 * Deterministic by seed, because a go/no-go decision that flips between runs is
 * not a decision.
 */

import {
  ARCHETYPE_NAMES,
  getArchetype,
  makeRng,
  makeTraits,
  type ArchetypeName,
  type PlayerTraits,
} from "./archetypes.js";
import { rawSignals, zScores, type DailyMetrics } from "./signals.js";
import {
  DEFAULT_WEIGHTS,
  advanceDay,
  newSeasonState,
  type SeasonState,
  type Weights,
} from "./score.js";

/** `#5.2` — a season is four weeks. */
export const SEASON_DAYS = 28;
export const DEFAULT_SEASONS = 3;
export const DEFAULT_PLAYERS = 500;

export interface SimulationOptions {
  players?: number;
  seasons?: number;
  seasonDays?: number;
  weights?: Weights;
  seed?: number;
}

export interface PlayerResult {
  id: number;
  archetype: ArchetypeName;
  /** Seasonal points at the end of the final season. */
  points: number;
  /** Mean across seasons, so one lucky season cannot carry a player. */
  meanSeasonPoints: number;
  activeDays: number;
  inactiveDays: number;
  effectiveTokens: number;
  commits: number;
  /** 1-based, 1 = best. */
  rank: number;
  /** Position in the field, 0 = best, 1 = worst. */
  percentile: number;
}

export interface ArchetypeSummary {
  archetype: ArchetypeName;
  attacks: string;
  players: number;
  /** Best (lowest) percentile any player of this archetype reached. */
  bestPercentile: number;
  medianPercentile: number;
  meanPoints: number;
  /** How many landed in the top 10% / 25% of the whole field. */
  inTop10Pct: number;
  inTop25Pct: number;
  meanEffectiveTokens: number;
  meanCommits: number;
}

export interface SimulationResult {
  options: Required<Omit<SimulationOptions, "weights">> & { weights: Weights };
  players: PlayerResult[];
  byArchetype: ArchetypeSummary[];
}

interface Player {
  id: number;
  archetype: ArchetypeName;
  traits: PlayerTraits;
  seasonPoints: number[];
  totals: { effectiveTokens: number; commits: number; activeDays: number; inactiveDays: number };
}

export function simulate(options: SimulationOptions = {}): SimulationResult {
  const players = options.players ?? DEFAULT_PLAYERS;
  const seasons = options.seasons ?? DEFAULT_SEASONS;
  const seasonDays = options.seasonDays ?? SEASON_DAYS;
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const seed = options.seed ?? 20260909;

  const rng = makeRng(seed);

  // Even split across archetypes, so no archetype gets an advantage from
  // sample size.
  const roster: Player[] = [];
  for (let i = 0; i < players; i++) {
    const archetype = ARCHETYPE_NAMES[i % ARCHETYPE_NAMES.length]!;
    roster.push({
      id: i,
      archetype,
      traits: makeTraits(rng),
      seasonPoints: [],
      totals: { effectiveTokens: 0, commits: 0, activeDays: 0, inactiveDays: 0 },
    });
  }

  for (let season = 0; season < seasons; season++) {
    const states = new Map<number, SeasonState>(
      roster.map((p) => [p.id, newSeasonState()]),
    );

    for (let day = 0; day < seasonDays; day++) {
      // Generate the whole cohort's day first: z-scores are cohort-relative,
      // so no player's score exists until everyone's metrics do.
      const metrics: DailyMetrics[] = roster.map((p) =>
        getArchetype(p.archetype).day({ day, rng }, p.traits),
      );

      const zs = zScores(metrics.map(rawSignals));

      roster.forEach((p, i) => {
        const before = states.get(p.id)!;
        states.set(p.id, advanceDay(before, metrics[i]!, zs[i]!, weights));

        const m = metrics[i]!;
        p.totals.effectiveTokens += m.inputTokens + m.outputTokens + m.cacheWriteTokens;
        p.totals.commits += m.commits;
      });
    }

    for (const p of roster) {
      const state = states.get(p.id)!;
      p.seasonPoints.push(state.points);
      p.totals.activeDays += state.activeDays;
      p.totals.inactiveDays += state.inactiveDays;
    }
  }

  const scored = roster.map((p) => ({
    player: p,
    // Mean across seasons: a single fluke season should not decide the gate.
    meanSeasonPoints: p.seasonPoints.reduce((a, b) => a + b, 0) / p.seasonPoints.length,
    finalPoints: p.seasonPoints[p.seasonPoints.length - 1] ?? 0,
  }));

  scored.sort((a, b) => b.meanSeasonPoints - a.meanSeasonPoints);

  const results: PlayerResult[] = scored.map((s, index) => ({
    id: s.player.id,
    archetype: s.player.archetype,
    points: s.finalPoints,
    meanSeasonPoints: s.meanSeasonPoints,
    activeDays: s.player.totals.activeDays,
    inactiveDays: s.player.totals.inactiveDays,
    effectiveTokens: s.player.totals.effectiveTokens,
    commits: s.player.totals.commits,
    rank: index + 1,
    // 0 = best. With n players, rank 1 -> 0 and rank n -> ~1.
    percentile: scored.length > 1 ? index / (scored.length - 1) : 0,
  }));

  return {
    options: { players, seasons, seasonDays, seed, weights },
    players: results,
    byArchetype: summarize(results),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function summarize(results: readonly PlayerResult[]): ArchetypeSummary[] {
  return ARCHETYPE_NAMES.map((archetype) => {
    const group = results.filter((r) => r.archetype === archetype);
    const percentiles = group.map((r) => r.percentile);

    return {
      archetype,
      attacks: getArchetype(archetype).attacks,
      players: group.length,
      bestPercentile: percentiles.length > 0 ? Math.min(...percentiles) : 1,
      medianPercentile: median(percentiles),
      meanPoints:
        group.reduce((a, r) => a + r.meanSeasonPoints, 0) / Math.max(1, group.length),
      inTop10Pct: group.filter((r) => r.percentile < 0.1).length,
      inTop25Pct: group.filter((r) => r.percentile < 0.25).length,
      meanEffectiveTokens:
        group.reduce((a, r) => a + r.effectiveTokens, 0) / Math.max(1, group.length),
      meanCommits: group.reduce((a, r) => a + r.commits, 0) / Math.max(1, group.length),
    };
  });
}
