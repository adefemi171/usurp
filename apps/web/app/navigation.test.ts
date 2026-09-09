import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pathname: "/", user: undefined as { handle: string } | undefined, providers: ["github"] as string[] }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname, redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("../lib/session", () => ({ currentUser: async () => state.user }));
vi.mock("../lib/env", () => ({ availableProviders: () => state.providers, devAuthEnabled: () => false }));
import AppNav from "./app-nav";
import SignInPage from "./signin/page";
import NotFound from "./not-found";
import BoardNav from "./board-nav";

beforeEach(() => { state.pathname = "/"; state.user = undefined; state.providers = ["github"]; });

describe("application navigation", () => {
  it("gives visitors a working sign-in link without an invented usage profile", () => {
    const html = renderToStaticMarkup(createElement(AppNav));
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain("My usage");
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Overview<\/a>/);
  });
  it("keeps signed-in usage and settings accessible and identifies the current section", () => {
    state.pathname = "/u/member";
    const html = renderToStaticMarkup(createElement(AppNav, { handle: "member" }));
    expect(html).toContain('href="/u/member?window=all"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>My usage<\/a>/);
    expect(html).toContain('href="/settings"');
    expect(html).not.toContain('href="/signin"');
  });
  it("does not offer time-window controls for seasonal ratings", () => {
    const html = renderToStaticMarkup(createElement(BoardNav, { metric: "rating", window: "all" }));
    expect(html).not.toContain('aria-label="Window"');
    expect(html).toContain('aria-current="true">Rating');
  });
  it("provides recovery links without revealing whether a private profile exists", () => {
    const html = renderToStaticMarkup(createElement(NotFound));
    expect(html).toContain("may be private");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/settings"');
  });
});

describe("sign-in experience", () => {
  it("renders configured OAuth links and preserves the return destination", async () => {
    state.providers = ["github", "google"];
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ return_to: "/settings#devices" }) }));
    expect(html).toContain('href="/auth/github?return_to=%2Fsettings%23devices"');
    expect(html).toContain('href="/auth/google?return_to=%2Fsettings%23devices"');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('href="/auth/apple');
    expect(html).toContain("never joins a public board automatically");
  });
  it("explains missing configuration instead of displaying a dead sign-in form", async () => {
    state.providers = [];
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("No sign-in provider is enabled");
    expect(html).not.toContain('href="/auth/');
  });
  it("announces known errors without reflecting arbitrary query text", async () => {
    const html = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ error: "injected-message" }) }));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("injected-message");
  });
  it("redirects an existing session to settings", async () => {
    state.user = { handle: "member" };
    await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("redirect:/settings");
  });
});
