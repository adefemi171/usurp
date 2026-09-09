import type { UsageSeriesPoint } from "@usurp/db";

export type EfficiencyAdvice = {
  id: "cache" | "model" | "exploration" | "local";
  title: string;
  detail: string;
  action: string;
};

/**
 * Advice is intentionally derived only from the aggregates Usurp already
 * collects. It must never imply that we saw a prompt, repository, command, or
 * tool call — those data do not leave the member's computer.
 */
export function efficiencyAdvice(rows: UsageSeriesPoint[]): EfficiencyAdvice[] {
  const measured = rows.filter((row) => row.calls > 0 || row.effectiveTokens > 0);
  if (!measured.length) return [];

  const input = measured.reduce((total, row) => total + row.inputTokens, 0);
  const cacheRead = measured.reduce((total, row) => total + row.cacheReadTokens, 0);
  const calls = measured.reduce((total, row) => total + row.calls, 0);
  const edits = measured.reduce((total, row) => total + row.editsApplied, 0);
  const cost = measured.reduce((total, row) => total + row.costMicros, 0);
  const byModel = new Map<string, number>();
  for (const row of measured) byModel.set(row.model, (byModel.get(row.model) ?? 0) + row.costMicros);
  const top = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0];
  const advice: EfficiencyAdvice[] = [];

  if (input >= 10_000 && cacheRead / input < 0.1) advice.push({
    id: "cache",
    title: "Low cache reuse",
    detail: `${Math.round(cacheRead / input * 100)}% of reported input tokens were cache reads in this view.`,
    action: "Keep rules and tool definitions stable. Put timestamps, status, and other changing context in the per-turn message.",
  });
  if (cost > 0 && top && top[1] / cost >= 0.6) advice.push({
    id: "model",
    title: "One model dominates spend",
    detail: `${top[0]} accounts for ${Math.round(top[1] / cost * 100)}% of priced usage here.`,
    action: "Reserve it for judgment-heavy work; use deterministic tools or a lower-cost model for search, formatting, and routine checks.",
  });
  if (calls >= 12 && edits / calls < 0.2) advice.push({
    id: "exploration",
    title: "Many calls, few recorded edits",
    detail: `${calls} native calls produced ${edits} recorded edits in this view. This can indicate exploration-heavy work.`,
    action: "Start mechanical investigation with rg, git history, type checks, or a project script before asking an agent to explore broadly.",
  });
  advice.push({
    id: "local",
    title: "Compile repeated work locally",
    detail: "Usurp only receives aggregate usage, so it cannot inspect prompts, commands, projects, or tool calls.",
    action: "Use Usurp Connect’s local service for private coaching: turn repeated prompts into a command, Skill, script, hook, or CI check. Consider Runeward when you need budgets and policy enforced before an agent runs.",
  });
  return advice;
}
