import { afterEach, describe, expect, it, vi } from "vitest";
import { localAuthEnabled, localPasswordMatches } from "./local-auth";
afterEach(() => vi.unstubAllEnvs());
describe("offline owner authentication", () => {
  it("requires explicit local mode, a loopback origin and a strong password", () => {
    vi.stubEnv("USURP_LOCAL_ONLY", "1");
    vi.stubEnv("USURP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("USURP_LOCAL_PASSWORD", "a".repeat(43));
    expect(localAuthEnabled()).toBe(true);
    expect(localPasswordMatches("a".repeat(43))).toBe(true);
    expect(localPasswordMatches("wrong")).toBe(false);
    vi.stubEnv("USURP_BASE_URL", "https://usurp.onrender.com");
    expect(localAuthEnabled()).toBe(false);
    vi.stubEnv("USURP_BASE_URL", "http://localhost:3000");
    vi.stubEnv("USURP_LOCAL_PASSWORD", "short");
    expect(localAuthEnabled()).toBe(false);
    vi.stubEnv("USURP_LOCAL_PASSWORD", "a".repeat(43));
    vi.stubEnv("USURP_LOCAL_ONLY", "0");
    expect(localPasswordMatches("a".repeat(43))).toBe(false);
  });
});
