import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import InvitePrompt from "./invite-prompt";

describe("InvitePrompt", () => {
  it("links a solo signed-in member to their synced usage", () => {
    const html = renderToStaticMarkup(
      createElement(InvitePrompt, {
        arenaName: "Global",
        arenaType: "global",
        inviteCode: null,
        memberCount: 1,
        profileHref: "/u/member",
      }),
    );

    expect(html).toContain("Explore your own activity while the arena grows.");
    expect(html).not.toContain("Your usage is synced.");
    expect(html).toContain('href="/u/member"');
    expect(html).toContain("View your usage breakdown");
  });
});
