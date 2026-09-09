import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UsageSeriesPoint } from "@usurp/db";
vi.mock("next/navigation", () => ({ usePathname: () => "/u/test", useRouter: () => ({ refresh() {}, push() {} }) }));
import UsageDashboard from "./usage-dashboard";
const row: UsageSeriesPoint = {
  day: "2026-09-09", agent: "codex", model: "test-model", inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 500,
  effectiveTokens: 120, costMicros: 1234567, calls: 0, sessionsStarted: 0, sessionsCompleted: 0, sessionsAbandoned: 0, editsApplied: 0, editsReverted: 0, commits: 0,
  historicalBuckets: 0, unpricedBuckets: 0, source: "agentsview", callsAvailable: false,
};
function render(rows = [row], canRefreshSource = true) {
  return renderToStaticMarkup(createElement(UsageDashboard, { rows, window: "all", flagged: true, deviceCount: 1, lastSeen: null, bridgeImports: [{ importedAt: "2026-09-09T12:00:00Z", pricingVersion: "v1", agents: ["codex"] }], canRefreshSource, isOwner: true }));
}
describe("usage dashboard source clarity", () => {
  it("does not report a zero daily cost or no activity for measured but unpriced usage", () => {
    const html = render([{ ...row, source: "native", agent: "cursor", costMicros: 0, unpricedBuckets: 1 }]);
    expect(html).toContain("AVERAGE / ACTIVE DAY</span><strong>Unavailable");
    expect(html).toContain("Usage not available for this metric");
    expect(html).not.toContain("$0.00");
  });
  it("shows source cost with cents and a real source-refresh label", () => {
    const html = render(); expect(html).toContain("$1.23"); expect(html).toContain("Refresh source");
    expect(html).toContain("historical API rates"); expect(html).not.toContain("Some records in this time window");
    expect(html).toContain("Data sources &amp; coverage");
  });
  it("does not pretend cloud refresh collects local data", () => { expect(render([row], false)).toContain("Refresh view"); });
  it("labels absent snapshot counters unavailable", () => {
    const html = render(); expect(html).toContain("<td>Unavailable</td>"); expect(html).not.toContain("0 conversations");
  });
  it("keeps metadata-only models out of measured rankings and avoids fake zero usage", () => {
    const html = render([{ ...row, source: "native", model: "metadata-only", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicros: 0, effectiveTokens: 0, sessionsStarted: 1 }]);
    expect(html).toContain("Partial data coverage"); expect(html).toContain("Token counters are unavailable");
    expect(html).not.toContain("All measured usage priced");
    expect(html).not.toContain("Switch to Tokens to see recorded activity");
    expect(html).toContain("No measured model usage");
  });
});
