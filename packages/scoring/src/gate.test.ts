/**
 * The ship gate, as a test.
 *
 * `SPEC.md#1` says: if the rating model cannot beat naive burn in simulation,
 * kill the project. That makes this the single most consequential assertion in
 * the codebase — a regression here is not a bug, it is a go/no-go changing.
 *
 * It runs on multiple seeds because a gate that passes on one seed has told you
 * about that seed. A 3-seed search once recommended a weighting that then
 * breached the gate on 2 of 8 seeds.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS } from "./score.js";
import { evaluateGate } from "./gate.js";
import { simulate } from "./simulate.js";
import { ARCHETYPE_NAMES } from "./archetypes.js";

/** Same seeds `npm run simulate` uses, so CLI and CI agree. */
const SEEDS = [0, 1, 2, 3, 4].map((i) => 20260909 + i * 7919);

// A smaller field than the CLI's 500 keeps the suite quick while preserving
// the cohort dynamics the z-scores depend on.
const PLAYERS = 250;
const SEASONS = 3;

describe("SPEC.md#4.4 ship gate", () => {
  for (const seed of SEEDS) {
    it(`passes with the default weights (seed ${seed})`, () => {
      const result = simulate({ players: PLAYERS, seasons: SEASONS, seed });
      const gate = evaluateGate(result);

      // Name the failing checks, so a regression says *what* broke.
      expect(gate.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([]);
      expect(gate.passed).toBe(true);
    });
  }

  it("keeps whale_burner out of the top 10% despite ~40x the volume", () => {
    const result = simulate({ players: PLAYERS, seasons: SEASONS, seed: SEEDS[0]! });
    const whale = result.byArchetype.find((s) => s.archetype === "whale_burner")!;
    const intended = result.byArchetype.find((s) => s.archetype === "efficient_daily")!;

    // The whole premise: more tokens, worse rank.
    expect(whale.meanEffectiveTokens).toBeGreaterThan(intended.meanEffectiveTokens * 10);
    expect(whale.inTop10Pct).toBe(0);
    expect(whale.meanPoints).toBeLessThan(intended.meanPoints);
  });

  it("ranks efficient_daily first overall", () => {
    const result = simulate({ players: PLAYERS, seasons: SEASONS, seed: SEEDS[0]! });
    expect(result.players[0]!.archetype).toBe("efficient_daily");
  });

  it("fails loudly if the model is reduced to pure volume", () => {
    // Zero weights make efficiency_mult a constant 1.0 — ranking by burn,
    // which `#4.1` says is volume, not skill. The gate must catch that.
    const result = simulate({
      players: PLAYERS,
      seasons: SEASONS,
      seed: SEEDS[0]!,
      weights: { cacheReuse: 0, yieldPerMTok: 0, completion: 0 },
    });
    const gate = evaluateGate(result);

    expect(gate.passed).toBe(false);
    const whale = result.byArchetype.find((s) => s.archetype === "whale_burner")!;
    expect(whale.inTop10Pct).toBeGreaterThan(0);
  });

  it("excludes the whale on the penalty-only cache signal alone", () => {
    // I expected this to fail the gate and it does not — worth recording.
    // With `cacheReuse` weighted alone, the whale's constant re-caching
    // (0.63 reuse vs ~0.96 for everyone else) drags it to the multiplier
    // floor, and that single penalty is enough to satisfy all five checks.
    //
    // So the cache term is load-bearing for the *whale*, and the yield term
    // is load-bearing for the *gamers* — they are not redundant.
    const result = simulate({
      players: PLAYERS,
      seasons: SEASONS,
      seed: SEEDS[0]!,
      weights: { cacheReuse: 0.3, yieldPerMTok: 0, completion: 0 },
    });

    const whale = result.byArchetype.find((s) => s.archetype === "whale_burner")!;
    expect(whale.inTop10Pct).toBe(0);
  });

  it("cannot separate cache_gamer from efficient_daily without the yield term", () => {
    // The complement of the test above, and the reason `DEFAULT_WEIGHTS` is
    // yield-led: with only the penalty-only cache signal, both the gamer and
    // the intended player contribute 0, so nothing tells them apart and the
    // gamer rides its volume up the board.
    const cacheOnly = simulate({
      players: PLAYERS,
      seasons: SEASONS,
      seed: SEEDS[0]!,
      weights: { cacheReuse: 0.3, yieldPerMTok: 0, completion: 0 },
    });
    const yieldLed = simulate({ players: PLAYERS, seasons: SEASONS, seed: SEEDS[0]! });

    const gamer = (r: typeof cacheOnly) =>
      r.byArchetype.find((s) => s.archetype === "cache_gamer")!.medianPercentile;

    // Adding yield pushes the gamer materially down the board.
    expect(gamer(yieldLed)).toBeGreaterThan(gamer(cacheOnly));
  });
});

describe("simulate", () => {
  it("is deterministic for a given seed", () => {
    const a = simulate({ players: 100, seasons: 2, seed: 42 });
    const b = simulate({ players: 100, seasons: 2, seed: 42 });

    // A go/no-go decision that flips between runs is not a decision.
    expect(a.players.map((p) => [p.id, p.meanSeasonPoints])).toEqual(
      b.players.map((p) => [p.id, p.meanSeasonPoints]),
    );
  });

  it("produces different results for different seeds", () => {
    const a = simulate({ players: 100, seasons: 2, seed: 1 });
    const b = simulate({ players: 100, seasons: 2, seed: 2 });
    expect(a.players[0]!.meanSeasonPoints).not.toBe(b.players[0]!.meanSeasonPoints);
  });

  it("splits the field evenly across archetypes", () => {
    const result = simulate({ players: 500, seasons: 1, seed: 7 });
    for (const name of ARCHETYPE_NAMES) {
      expect(result.byArchetype.find((s) => s.archetype === name)!.players).toBe(100);
    }
  });

  it("assigns ranks and percentiles consistently", () => {
    const result = simulate({ players: 50, seasons: 1, seed: 9 });

    expect(result.players[0]!.rank).toBe(1);
    expect(result.players[0]!.percentile).toBe(0);
    expect(result.players.at(-1)!.percentile).toBeCloseTo(1);

    // Sorted best-first.
    for (let i = 1; i < result.players.length; i++) {
      expect(result.players[i]!.meanSeasonPoints).toBeLessThanOrEqual(
        result.players[i - 1]!.meanSeasonPoints,
      );
    }
  });

  it("penalises the sporadic player through decay", () => {
    const result = simulate({ players: PLAYERS, seasons: SEASONS, seed: SEEDS[0]! });
    const sporadic = result.byArchetype.find((s) => s.archetype === "sporadic_genius")!;
    const intended = result.byArchetype.find((s) => s.archetype === "efficient_daily")!;

    // Same quality of work, far fewer days: `#4.3` should cost it dearly.
    expect(sporadic.medianPercentile).toBeGreaterThan(intended.medianPercentile);
  });
});

describe("evaluateGate", () => {
  it("reports every check with its requirement and observation", () => {
    const gate = evaluateGate(simulate({ players: 100, seasons: 1, seed: 3 }));
    expect(gate.checks).toHaveLength(5);
    for (const check of gate.checks) {
      expect(check.name.length).toBeGreaterThan(0);
      expect(check.requirement.length).toBeGreaterThan(0);
      expect(check.observed.length).toBeGreaterThan(0);
    }
  });

  it("also checks the positive claim, not just the three prohibitions", () => {
    // `#4.4` states the gate as prohibitions, which a random ranking would
    // satisfy. The gate must also require that the intended behaviour wins.
    const gate = evaluateGate(simulate({ players: 100, seasons: 1, seed: 3 }));
    const names = gate.checks.map((c) => c.name);
    expect(names.some((n) => n.includes("efficient_daily"))).toBe(true);
  });

  it("weights DEFAULT_WEIGHTS toward yield", () => {
    // The only signal a gamer cannot fake without doing the work.
    expect(DEFAULT_WEIGHTS.yieldPerMTok).toBeGreaterThan(DEFAULT_WEIGHTS.cacheReuse);
    expect(DEFAULT_WEIGHTS.yieldPerMTok).toBeGreaterThan(DEFAULT_WEIGHTS.completion);
  });
});
