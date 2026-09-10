import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreakBadge, ToolBadges } from "./arena-badges";

describe("arena badges", () => {
  it.each([1, 7, 35])("labels a %i-day streak accessibly", days => {
    const html = renderToStaticMarkup(createElement(StreakBadge, { days }));
    expect(html).toContain(`${days} ${days === 1 ? "day" : "days"}`);
    expect(html).toContain('aria-hidden="true"');
  });
  it("does not display a flame for no activity", () => {
    expect(renderToStaticMarkup(createElement(StreakBadge, { days: 0 }))).toContain("No current streak");
  });
  it("renders nothing when tools are private or absent", () => {
    expect(renderToStaticMarkup(createElement(ToolBadges, { tools: [] }))).toBe("");
  });
  it("keeps extra tools in a keyboard-accessible disclosure", () => {
    const html = renderToStaticMarkup(createElement(ToolBadges, { tools: ["codex", "cursor", "qwen"] }));
    expect(html).toContain("Codex"); expect(html).toContain("Cursor");
    expect(html).toContain("<details"); expect(html).toContain("Show 1 more coding tools");
    expect(html).toContain("Qwen");
  });
  it("escapes unknown source labels", () => {
    expect(renderToStaticMarkup(createElement(ToolBadges, { tools: ["<script>"] }))).toContain("&lt;script&gt;");
  });
});
