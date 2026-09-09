import { describe, expect, it } from "vitest";
import { efficiencyAdvice } from "./efficiency-advice";
import type { UsageSeriesPoint } from "@usurp/db";

const point = (overrides: Partial<UsageSeriesPoint> = {}): UsageSeriesPoint => ({
  day: "2026-09-09", agent: "codex", model: "gpt-6", inputTokens: 20_000, outputTokens: 100,
  cacheWriteTokens: 0, cacheReadTokens: 0, effectiveTokens: 20_100, costMicros: 2_000_000,
  calls: 20, sessionsStarted: 0, sessionsCompleted: 0, sessionsAbandoned: 0, editsApplied: 1,
  editsReverted: 0, commits: 0, historicalBuckets: 0, unpricedBuckets: 0, source: "native",
  callsAvailable: true, ...overrides,
});

describe("efficiencyAdvice", () => {
  it("uses aggregates for cache, model, and exploration advice", () => {
    expect(efficiencyAdvice([point()]).map((advice) => advice.id)).toEqual(["cache", "model", "exploration", "local"]);
  });

  it("does not claim cache or model savings without enough evidence", () => {
    expect(efficiencyAdvice([point({ inputTokens: 500, cacheReadTokens: 500, calls: 1, editsApplied: 1, costMicros: 0 })]).map((advice) => advice.id)).toEqual(["local"]);
  });
});
