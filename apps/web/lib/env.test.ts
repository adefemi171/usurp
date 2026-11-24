import { afterEach, describe, expect, it, vi } from "vitest";
import { baseUrl, isSecureOrigin } from "./env";
afterEach(() => vi.unstubAllEnvs());
describe("deployment origin", () => {
  it("ignores retired Render configuration and defaults to localhost", () => {
    vi.stubEnv("USURP_BASE_URL", ""); vi.stubEnv("RENDER_EXTERNAL_URL", "https://demo.onrender.com");
    expect(baseUrl()).toBe("http://localhost:3000"); expect(isSecureOrigin()).toBe(false);
  });
  it("prefers an explicitly configured domain", () => {
    vi.stubEnv("USURP_BASE_URL", "https://league.example.com/"); vi.stubEnv("RENDER_EXTERNAL_URL", "https://demo.onrender.com");
    expect(baseUrl()).toBe("https://league.example.com");
  });
});
