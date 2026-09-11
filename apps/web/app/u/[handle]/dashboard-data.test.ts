import { describe, expect, it } from "vitest";
import type { UsageSeriesPoint } from "@usurp/db";
import { chartDays, colorFor, compact, filterSeries, money, number, percentage, sharesFor, summarizeSeries, treemap } from "./dashboard-data";

const point = (overrides: Partial<UsageSeriesPoint> = {}): UsageSeriesPoint => ({
  day: "2026-05-05", agent: "vscode-copilot", model: "claude-sonnet-4-6",
  inputTokens: 18593, outputTokens: 287, cacheWriteTokens: 0, cacheReadTokens: 0,
  effectiveTokens: 18880, costMicros: 60084, calls: 1, sessionsStarted: 1,
  sessionsCompleted: 1, sessionsAbandoned: 0, editsApplied: 0, editsReverted: 0,
  commits: 0, historicalBuckets: 1, unpricedBuckets: 0, ...overrides,
});

describe("dashboard aggregation", () => {
  it("preserves formatting precision at currency and compact-number boundaries", () => {
    for (const value of [0, 1, 12345, 999999, 1000000, 1234567890]) {
      expect(number(value)).toBe(value.toLocaleString("en-US"));
      expect(compact(value)).toBe(new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1_000_000_000 ? 2 : 1 }).format(value));
      expect(money(value)).toBe(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: value > 0 && value < 1_000_000 ? 4 : 2 }).format(value / 1_000_000));
    }
  });
  it("does not label small nonzero shares as zero", () => {
    expect(percentage(1, 10000)).toBe("<0.1%");
    expect(percentage(0, 0)).toBe("0.0%");
  });
  it("gives the observed token models distinct stable colors", () => {
    const names = ["gpt-5.6-sol", "gpt-5.6-terra", "codex-auto-review", "gpt-6-astra", "gpt-5.3-codex", "claude-sonnet-4-6"];
    expect(new Set(names.map(colorFor)).size).toBe(names.length);
  });
  it("filters by the intersection of model and agent", () => {
    const rows = [point(), point({ agent: "cursor" }), point({ model: "other" })];
    expect(filterSeries(rows, "vscode-copilot", "claude-sonnet-4-6")).toEqual([rows[0]]);
    expect(filterSeries(rows, "missing", "")).toEqual([]);
  });
  it("conserves totals across grouping and metric switches", () => {
    const rows = [point(), point({ agent: "cursor", day: "2026-05-06" }), point({ model: "other" })];
    for (const grouping of ["agent", "model"] as const) {
      for (const metric of ["tokens", "cost"] as const) {
        const expected = metric === "tokens" ? 18880 * 3 : 60084 * 3;
        expect(sharesFor(rows, grouping, metric).reduce((s, r) => s + r.value, 0)).toBe(expected);
        expect(chartDays(rows, grouping, metric).reduce((s, r) => s + r.total, 0)).toBe(expected);
      }
    }
  });
  it("fills missing UTC dates with zero, not invented activity", () => {
    const days = chartDays([point(), point({ day: "2026-05-07" })], "model", "tokens");
    expect(days.map(d => d.day)).toEqual(["2026-05-05", "2026-05-06", "2026-05-07"]);
    expect(days[1]).toEqual({ day: "2026-05-06", values: {}, total: 0 });
  });
  it("handles empty and one-day selections", () => {
    expect(chartDays([], "model", "tokens")).toEqual([]);
    expect(chartDays([point()], "model", "tokens")).toHaveLength(1);
    expect(summarizeSeries([])).toMatchObject({ tokens: 0, activeDays: 0, models: 0 });
  });
  it("keeps zero-cost unpriced activity in token mode without inventing a price", () => {
    const rows = [point({ costMicros: 0, unpricedBuckets: 1 })];
    expect(sharesFor(rows, "model", "cost")).toEqual([]);
    expect(sharesFor(rows, "model", "tokens")[0]?.value).toBe(18880);
    expect(summarizeSeries(rows).unpriced).toBe(1);
  });
  it("does not count session-only placeholders as used models or active days", () => {
    const rows = [point({ calls: 0, effectiveTokens: 0 })];
    expect(summarizeSeries(rows)).toMatchObject({ activeDays: 0, models: 0 });
  });
  it("keeps model ids that match object prototype keys safe", () => {
    const day = chartDays([point({ model: "constructor" })], "model", "tokens")[0]!;
    expect(day.values.constructor).toBe(18880);
  });
});

describe("proportional treemap", () => {
  it("uses exactly the available area without negative or overflowing tiles", () => {
    const shares = [70, 19, 10, 1, 0].map((value, i) => ({ name: String(i), value }));
    const tiles = treemap(shares);
    expect(tiles).toHaveLength(4);
    expect(tiles.reduce((s, t) => s + t.width * t.height, 0)).toBeCloseTo(10000);
    for (const t of tiles) {
      expect(t.width * t.height / 10000).toBeCloseTo(t.value / 100);
      expect(t.x + t.width).toBeLessThanOrEqual(100.000001);
      expect(t.y + t.height).toBeLessThanOrEqual(100.000001);
      expect(t.width).toBeGreaterThan(0); expect(t.height).toBeGreaterThan(0);
    }
    for (const [i, a] of tiles.entries()) for (const b of tiles.slice(i + 1)) {
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(overlapX <= 1e-8 || overlapY <= 1e-8).toBe(true);
    }
  });
  it("handles empty and single-category datasets", () => {
    expect(treemap([])).toEqual([]);
    expect(treemap([{ name: "Claude", value: 18880 }])).toEqual([
      { name: "Claude", value: 18880, x: 0, y: 0, width: 100, height: 100 },
    ]);
  });
});
