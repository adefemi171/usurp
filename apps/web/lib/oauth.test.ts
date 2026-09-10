import { afterEach, describe, expect, it, vi } from "vitest";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

async function configuredOAuth() {
  process.env.AUTH_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  process.env.USURP_BASE_URL = "http://localhost:3000";
  process.env.GITHUB_CLIENT_ID = "github-client";
  process.env.GITHUB_CLIENT_SECRET = "github-secret";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  return import("./oauth.js");
}

describe("configured OAuth providers", () => {
  it("creates a GitHub authorization redirect with the registered callback", async () => {
    const { getProvider, startFlow } = await configuredOAuth();
    const provider = getProvider("github");
    expect(provider).toBeDefined();

    const started = startFlow(provider!, "/settings");
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("github-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/auth/github/callback",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("disables Google even when old credentials remain configured", async () => {
    const { getProvider } = await configuredOAuth();
    expect(getProvider("google")).toBeUndefined();
    const { availableProviders } = await import("./env.js");
    expect(availableProviders()).not.toContain("google");
  });
});
