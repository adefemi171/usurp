import { afterEach, describe, expect, it, vi } from "vitest";
import { baseUrl, isSecureOrigin } from "./env";
afterEach(() => vi.unstubAllEnvs());
describe("deployment origin", () => {
  it("uses Render's HTTPS address when no custom domain is configured", () => {
    vi.stubEnv("USURP_BASE_URL", ""); vi.stubEnv("RENDER_EXTERNAL_URL", "https://demo.onrender.com");
    expect(baseUrl()).toBe("https://demo.onrender.com"); expect(isSecureOrigin()).toBe(true);
  });
  it("prefers an explicitly configured domain", () => {
    vi.stubEnv("USURP_BASE_URL", "https://league.example.com/"); vi.stubEnv("RENDER_EXTERNAL_URL", "https://demo.onrender.com");
    expect(baseUrl()).toBe("https://league.example.com");
  });
});
