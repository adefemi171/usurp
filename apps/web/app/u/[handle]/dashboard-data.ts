import type { UsageSeriesPoint } from "@usurp/db";

export type Metric = "tokens" | "cost";
export type Grouping = "model" | "agent";
export interface Share { name: string; value: number; }
export interface ChartDay { day: string; values: Record<string, number>; total: number; }
export interface Tile extends Share { x: number; y: number; width: number; height: number; }

export const number = (n: number) => n.toLocaleString("en-US");
export function compact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: n >= 1_000_000_000 ? 2 : 1 }).format(n);
}
export function money(micros: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: micros > 0 && micros < 1_000_000 ? 4 : 2 }).format(micros / 1_000_000);
}
export function percentage(value: number, total: number): string {
  const pct = total > 0 ? value / total * 100 : 0;
  return pct > 0 && pct < .1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}
export const valueOf = (r: UsageSeriesPoint, metric: Metric) => metric === "cost" ? r.costMicros : r.effectiveTokens;
export const formatValue = (n: number, metric: Metric) => metric === "cost" ? money(n) : compact(n);
export const sessionOnly = (r: UsageSeriesPoint) => r.calls === 0 && r.effectiveTokens === 0 && r.cacheReadTokens === 0 && r.costMicros === 0 && r.source !== "agentsview";
export function agentName(id: string): string {
  return ({ codex: "Codex", cursor: "Cursor", "claude-code": "Claude Code", "vscode-copilot": "VS Code Copilot" } as Record<string, string>)[id] ?? id;
}
export function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 66%)`;
}
export function filterSeries(rows: UsageSeriesPoint[], agent: string, model: string): UsageSeriesPoint[] {
  return rows.filter(r => (!agent || r.agent === agent) && (!model || r.model === model));
}
export function sharesFor(rows: UsageSeriesPoint[], grouping: Grouping, metric: Metric): Share[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row[grouping], (totals.get(row[grouping]) ?? 0) + valueOf(row, metric));
  return [...totals].map(([name, value]) => ({ name, value }))
    .filter(r => r.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

/** Zero-fill calendar days: never draw uninterrupted usage across a long gap. */
export function chartDays(rows: UsageSeriesPoint[], grouping: Grouping, metric: Metric): ChartDay[] {
  if (!rows.length) return [];
  const byDay = new Map<string, ChartDay>();
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { day: row.day, values: Object.create(null) as Record<string, number>, total: 0 };
    const key = row[grouping];
    entry.values[key] = (entry.values[key] ?? 0) + valueOf(row, metric);
    entry.total += valueOf(row, metric);
    byDay.set(row.day, entry);
  }
  const dates = [...byDay.keys()].sort();
  const result: ChartDay[] = [];
  for (let t = Date.parse(dates[0]!); t <= Date.parse(dates.at(-1)!); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    result.push(byDay.get(day) ?? { day, values: {}, total: 0 });
  }
  return result;
}

/** A binary treemap: tile area is exactly proportional to the reported value. */
export function treemap(shares: Share[], x = 0, y = 0, width = 100, height = 100): Tile[] {
  const items = shares.filter(s => s.value > 0);
  if (!items.length) return [];
  if (items.length === 1) return [{ ...items[0]!, x, y, width, height }];
  const total = items.reduce((sum, s) => sum + s.value, 0);
  let split = 1, left = items[0]!.value;
  while (split < items.length - 1 && Math.abs(left + items[split]!.value - total / 2) < Math.abs(left - total / 2)) {
    left += items[split++]!.value;
  }
  const ratio = left / total;
  return width >= height
    ? [...treemap(items.slice(0, split), x, y, width * ratio, height), ...treemap(items.slice(split), x + width * ratio, y, width * (1 - ratio), height)]
    : [...treemap(items.slice(0, split), x, y, width, height * ratio), ...treemap(items.slice(split), x, y + height * ratio, width, height * (1 - ratio))];
}

export function summarizeSeries(rows: UsageSeriesPoint[]) {
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, tokens: 0, cost: 0, calls: 0, unpriced: 0, historical: 0 };
  for (const r of rows) {
    totals.input += r.inputTokens; totals.output += r.outputTokens;
    totals.cacheWrite += r.cacheWriteTokens; totals.cacheRead += r.cacheReadTokens;
    totals.tokens += r.effectiveTokens; totals.cost += r.costMicros; totals.calls += r.calls;
    totals.unpriced += r.unpricedBuckets; totals.historical += r.historicalBuckets;
  }
  return { ...totals, activeDays: new Set(rows.filter(r => r.calls > 0 || r.effectiveTokens > 0).map(r => r.day)).size,
    models: new Set(rows.filter(r => r.calls > 0 || r.effectiveTokens > 0).map(r => r.model)).size };
}
