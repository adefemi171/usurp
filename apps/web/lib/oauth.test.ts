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

  it("creates a Google account redirect with PKCE", async () => {
    const { getProvider, startFlow } = await configuredOAuth();
    const provider = getProvider("google");
    expect(provider).toBeDefined();

    const started = startFlow(provider!, "/settings");
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("google-client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/auth/google/callback",
    );
    expect(url.searchParams.get("scope")).toContain("email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });
});
