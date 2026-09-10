import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TitleBadge from "./title-badge";

describe("rating title emblems", () => {
  it.each(["sovereign", "usurper", "contender"] as const)(
    "renders %s with a decorative vector and readable title",
    (title) => {
      const html = renderToStaticMarkup(createElement(TitleBadge, { title }));
      expect(html).toContain(`data-emblem="${title}"`);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('focusable="false"');
      expect(html).toContain(title[0]!.toUpperCase() + title.slice(1));
      expect(html).not.toContain("<img");
    },
  );
  it("does not award an icon to a member without a title", () => {
    expect(
      renderToStaticMarkup(createElement(TitleBadge, { title: undefined })),
    ).toBe("");
  });
});
