import { describe, expect, it } from "vitest";
import {
  DECAY_PER_INACTIVE_DAY,
  DEFAULT_WEIGHTS,
  EFFICIENCY_MAX,
  EFFICIENCY_MIN,
  STREAK_MAX,
  advanceDay,
  cacheReuseContribution,
  dailyScore,
  efficiencyMultiplier,
  isActive,
  newSeasonState,
  streakMultiplier,
  volumePoints,
} from "./score.js";
import {
  YIELD_VOLUME_FLOOR,
  effectiveTokens,
  rawSignals,
  zScores,
  type DailyMetrics,
  type SignalZScores,
} from "./signals.js";

function metrics(overrides: Partial<DailyMetrics> = {}): DailyMetrics {
  return {
    inputTokens: 100,
    outputTokens: 200,
    cacheWriteTokens: 700,
    cacheReadTokens: 5000,
    calls: 10,
    sessionsStarted: 4,
    sessionsCompleted: 3,
    sessionsAbandoned: 1,
    editsApplied: 8,
    editsReverted: 1,
    commits: 2,
    ...overrides,
  };
}

const zeroZ: SignalZScores = { cacheReuse: 0, yieldPerMTok: 0, completion: 0 };

describe("effectiveTokens", () => {
  it("excludes cache reads, which are ~10% of the input rate", () => {
    // Counting cheap reads as volume is exactly what rewards waste.
    const m = metrics({ inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 1_000_000 });
    expect(effectiveTokens(m)).toBe(6);
  });
});

describe("volumePoints", () => {
  it("approaches +10 points per 10x tokens", () => {
    const at = (tokens: number) =>
      volumePoints(metrics({ inputTokens: tokens, outputTokens: 0, cacheWriteTokens: 0 }));

    // `#4.2`'s "10x the tokens = +10 points" is asymptotic, not exact: the
    // `1 +` inside the log damps the first decade (2.0x at 1k, 9.6x by 100k).
    // That damping is desirable — it stops a near-empty day scoring a full
    // decade — so the test asserts convergence rather than a flat +10.
    expect(at(1_000_000) - at(100_000)).toBeCloseTo(10, 0);
    expect(at(10_000_000) - at(1_000_000)).toBeCloseTo(10, 0);

    // The damped low end, pinned so it cannot drift unnoticed.
    expect(at(10_000) - at(1_000)).toBeCloseTo(7.4, 1);
  });

  it("is zero for an empty day", () => {
    expect(volumePoints(metrics({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 }))).toBe(0);
  });

  it("is monotonic", () => {
    const at = (t: number) =>
      volumePoints(metrics({ inputTokens: t, outputTokens: 0, cacheWriteTokens: 0 }));
    expect(at(2000)).toBeGreaterThan(at(1000));
  });
});

describe("efficiencyMultiplier", () => {
  it("gives the median player a neutral 1.0 — the `1 +` centre", () => {
    // SPEC.md#4.2 as written omits the centre, which pins the median player
    // and everyone below it to the 0.5 floor. See the DEVIATION note.
    expect(efficiencyMultiplier(zeroZ, DEFAULT_WEIGHTS)).toBe(1);
  });

  it("rewards a good player above 1.0 and punishes a poor one below", () => {
    const good = efficiencyMultiplier(
      { cacheReuse: 2, yieldPerMTok: 2, completion: 2 },
      DEFAULT_WEIGHTS,
    );
    const poor = efficiencyMultiplier(
      { cacheReuse: -2, yieldPerMTok: -2, completion: -2 },
      DEFAULT_WEIGHTS,
    );

    expect(good).toBeGreaterThan(1);
    expect(poor).toBeLessThan(1);
  });

  it("discriminates across the bottom half rather than flooring it", () => {
    // The concrete failure of the uncentered formula: below-average players
    // were all indistinguishable at 0.5.
    const slightlyPoor = efficiencyMultiplier(
      { cacheReuse: 0, yieldPerMTok: -0.5, completion: -0.5 },
      DEFAULT_WEIGHTS,
    );
    const veryPoor = efficiencyMultiplier(
      { cacheReuse: 0, yieldPerMTok: -3, completion: -3 },
      DEFAULT_WEIGHTS,
    );

    expect(slightlyPoor).toBeGreaterThan(veryPoor);
    expect(slightlyPoor).toBeLessThan(1);
  });

  it("respects the `#4.2` bounds", () => {
    const huge = { cacheReuse: 100, yieldPerMTok: 100, completion: 100 };
    const tiny = { cacheReuse: -100, yieldPerMTok: -100, completion: -100 };
    expect(efficiencyMultiplier(huge, { cacheReuse: 5, yieldPerMTok: 5, completion: 5 })).toBe(
      EFFICIENCY_MAX,
    );
    expect(efficiencyMultiplier(tiny, { cacheReuse: 5, yieldPerMTok: 5, completion: 5 })).toBe(
      EFFICIENCY_MIN,
    );
  });

  it("clamps an outlier z so one freak day cannot dominate", () => {
    const atThree = efficiencyMultiplier({ ...zeroZ, yieldPerMTok: 3 }, DEFAULT_WEIGHTS);
    const atThirty = efficiencyMultiplier({ ...zeroZ, yieldPerMTok: 30 }, DEFAULT_WEIGHTS);
    expect(atThirty).toBe(atThree);
  });
});

describe("cacheReuseContribution", () => {
  it("is penalty-only: no bonus for a high ratio", () => {
    // The harness showed cache_gamer scoring 0.9992 against efficient_daily's
    // 0.9626, so any positive weight helped the gamer.
    expect(cacheReuseContribution(3)).toBe(0);
    expect(cacheReuseContribution(0.5)).toBe(0);
    expect(cacheReuseContribution(0)).toBe(0);
  });

  it("still punishes a low ratio — the re-cacher", () => {
    expect(cacheReuseContribution(-1)).toBe(-1);
    expect(cacheReuseContribution(-3)).toBe(-3);
    // Clamped, like the others.
    expect(cacheReuseContribution(-30)).toBe(-3);
  });

  it("means a gamer cannot out-score an honest user on cache alone", () => {
    const gamer = efficiencyMultiplier({ cacheReuse: 3, yieldPerMTok: -2, completion: 0 }, DEFAULT_WEIGHTS);
    const honest = efficiencyMultiplier({ cacheReuse: 0.5, yieldPerMTok: 1, completion: 0 }, DEFAULT_WEIGHTS);
    expect(honest).toBeGreaterThan(gamer);
  });
});

describe("streakMultiplier", () => {
  it("adds 3% per consecutive active day", () => {
    expect(streakMultiplier(0)).toBeCloseTo(1);
    expect(streakMultiplier(1)).toBeCloseTo(1.03);
    expect(streakMultiplier(5)).toBeCloseTo(1.15);
  });

  it("caps at 1.25, so a streak alone cannot carry a player", () => {
    expect(streakMultiplier(9)).toBeCloseTo(STREAK_MAX);
    expect(streakMultiplier(1000)).toBe(STREAK_MAX);
  });

  it("treats a negative streak as zero", () => {
    expect(streakMultiplier(-5)).toBe(1);
  });
});

describe("dailyScore", () => {
  it("multiplies the three factors", () => {
    const score = dailyScore(metrics(), zeroZ, 3, DEFAULT_WEIGHTS);
    expect(score.points).toBeCloseTo(score.volumePts * score.efficiencyMult * score.streakMult);
  });
});

describe("isActive", () => {
  it("is false only for a genuinely empty day", () => {
    expect(isActive(metrics())).toBe(true);
    expect(
      isActive(metrics({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, calls: 0 })),
    ).toBe(false);
  });
});

describe("advanceDay", () => {
  it("accumulates points and extends the streak on an active day", () => {
    const start = newSeasonState();
    const next = advanceDay(start, metrics(), zeroZ);

    expect(next.points).toBeGreaterThan(0);
    expect(next.streak).toBe(1);
    expect(next.activeDays).toBe(1);
    expect(next.inactiveDays).toBe(0);
  });

  it("decays 5% and resets the streak on an inactive day — `#4.3`", () => {
    const idle = metrics({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, calls: 0 });
    const state = { ...newSeasonState(), points: 1000, streak: 7, activeDays: 7 };

    const next = advanceDay(state, idle, zeroZ);

    expect(next.points).toBeCloseTo(1000 * (1 - DECAY_PER_INACTIVE_DAY));
    expect(next.streak).toBe(0);
    expect(next.inactiveDays).toBe(1);
  });

  it("makes standing still fall behind — the `#4.3` mechanic", () => {
    const idle = metrics({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, calls: 0 });
    let coasting = { ...newSeasonState(), points: 1000 };

    // Two weeks of coasting on a banked lead.
    for (let i = 0; i < 14; i++) coasting = advanceDay(coasting, idle, zeroZ);

    // 0.95^14 ≈ 0.49 — half the lead gone.
    expect(coasting.points).toBeLessThan(1000 * 0.5);
  });

  it("decays multiplicatively, so a bigger lead bleeds faster in absolute terms", () => {
    const idle = metrics({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, calls: 0 });
    const big = advanceDay({ ...newSeasonState(), points: 10_000 }, idle, zeroZ);
    const small = advanceDay({ ...newSeasonState(), points: 100 }, idle, zeroZ);

    expect(10_000 - big.points).toBeGreaterThan(100 - small.points);
  });
});

describe("YIELD_VOLUME_FLOOR", () => {
  it("bounds yield for a trivial-volume day", () => {
    // Without the floor, one commit on a ~1k-token day scored ~1000/MTok and
    // dominated the whole cohort's z-scores.
    const tiny = metrics({
      inputTokens: 500,
      outputTokens: 500,
      cacheWriteTokens: 0,
      commits: 1,
    });
    const signals = rawSignals(tiny);
    expect(signals.yieldPerMTok).toBeCloseTo(1 / (YIELD_VOLUME_FLOOR / 1_000_000));
    expect(signals.yieldPerMTok).toBeLessThan(11);
  });

  it("leaves a real user's yield untouched", () => {
    // Well above the floor, so the raw ratio applies.
    const real = metrics({
      inputTokens: 0,
      outputTokens: 500_000,
      cacheWriteTokens: 0,
      commits: 5,
    });
    expect(rawSignals(real).yieldPerMTok).toBeCloseTo(10);
  });

  it("stops a near-zero-volume player out-yielding a productive one", () => {
    // Before the floor, the farmer scored ~1000/MTok against the worker's 16.
    const farmer = rawSignals(
      metrics({ inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0, commits: 1 }),
    );
    const worker = rawSignals(
      metrics({ inputTokens: 0, outputTokens: 500_000, cacheWriteTokens: 0, commits: 8 }),
    );

    expect(farmer.yieldPerMTok).toBeCloseTo(10);
    expect(worker.yieldPerMTok).toBeCloseTo(16);
    expect(worker.yieldPerMTok!).toBeGreaterThan(farmer.yieldPerMTok!);
  });
});

describe("zScores", () => {
  it("centres a cohort on zero", () => {
    const cohort = [
      { cacheReuse: 0.2, yieldPerMTok: 1, completion: 0.5 },
      { cacheReuse: 0.5, yieldPerMTok: 2, completion: 0.7 },
      { cacheReuse: 0.8, yieldPerMTok: 3, completion: 0.9 },
    ];
    const zs = zScores(cohort);
    const sum = zs.reduce((a, z) => a + z.cacheReuse, 0);
    expect(sum).toBeCloseTo(0);
    expect(zs[1]!.cacheReuse).toBeCloseTo(0);
  });

  it("returns 0 for a zero-variance cohort rather than dividing by ~0", () => {
    const same = Array.from({ length: 5 }, () => ({
      cacheReuse: 0.9,
      yieldPerMTok: 10,
      completion: 1,
    }));
    for (const z of zScores(same)) {
      expect(z.cacheReuse).toBe(0);
      expect(z.yieldPerMTok).toBe(0);
      expect(z.completion).toBe(0);
    }
  });

  it("treats a missing signal as the cohort mean, not as worst-in-cohort", () => {
    // A user with no sessions has not demonstrated bad completion. Scoring
    // them as the worst would punish a short day and make "start a session
    // and abandon it" strictly better than not starting one.
    const cohort = [
      { cacheReuse: 0.9, yieldPerMTok: 10, completion: 1 },
      { cacheReuse: 0.5, yieldPerMTok: 2, completion: 0.4 },
      { cacheReuse: null, yieldPerMTok: null, completion: null },
    ];
    const zs = zScores(cohort);
    expect(zs[2]).toEqual({ cacheReuse: 0, yieldPerMTok: 0, completion: 0 });
  });

  it("handles an empty cohort", () => {
    expect(zScores([])).toEqual([]);
  });
});
