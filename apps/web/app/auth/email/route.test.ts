import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ issue: vi.fn(), consume: vi.fn(), invalidate: vi.fn(), signIn: vi.fn(), session: vi.fn(), link: vi.fn(), send: vi.fn(), user: vi.fn(), enabled: vi.fn(), cookie: vi.fn(), setSession: vi.fn() }));
vi.mock("@usurp/db", () => ({ getDb: () => ({}), issueEmailChallenge: mocks.issue, consumeEmailChallenge: mocks.consume, invalidateEmailChallenge: mocks.invalidate, signInWithOAuth: mocks.signIn, createSession: mocks.session, linkEmailIdentity: mocks.link }));
vi.mock("../../../lib/env", () => ({ baseUrl: () => "https://usurp.example", authSecret: () => "secret", emailAuthEnabled: mocks.enabled, isSecureOrigin: () => true }));
vi.mock("../../../lib/session", () => ({ currentUser: mocks.user, setSessionCookie: mocks.setSession }));
vi.mock("../../../lib/email", () => ({ sendSignInCode: mocks.send }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
import { POST } from "./route";
const request = (body: unknown, origin = "https://usurp.example") => new Request("https://usurp.example/auth/email", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); mocks.enabled.mockReturnValue(true); mocks.issue.mockResolvedValue({ token: "t".repeat(43), code: "12345678", email: "test@example.com" }); });
describe("email authentication routes", () => {
  it("rejects cross-origin and malformed requests before issuing email", async () => {
    expect((await POST(request({ action: "send", email: "test@example.com" }, "https://evil.example"))).status).toBe(403);
    expect((await POST(request(null))).status).toBe(400);
    expect((await POST(request({ extra: "x".repeat(2049) }))).status).toBe(413);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it("never returns the code and sets a secure browser-bound challenge cookie", async () => {
    const response = await POST(request({ action: "send", email: "test@example.com", returnTo: "https://evil.example" }));
    expect(response.status).toBe(200); expect(await response.text()).not.toContain("12345678");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly"); expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(mocks.issue.mock.calls[0]?.[1].returnTo).toBe("/");
  });
  it("invalidates undelivered codes instead of claiming successful delivery", async () => {
    mocks.send.mockRejectedValue(new Error("sensitive provider error"));
    const response = await POST(request({ action: "send", email: "test@example.com" }));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("sensitive"); expect(mocks.invalidate).toHaveBeenCalled();
  });
  it("preserves device approval after email verification", async () => {
    mocks.cookie.mockReturnValue({ value: "t".repeat(43) });
    mocks.consume.mockResolvedValue({ email: "test@example.com", returnTo: "/connect/approve?code=ABCD", linkUserId: null });
    mocks.signIn.mockResolvedValue({ user: { id: "u" }, created: true }); mocks.session.mockResolvedValue({ token: "session", expiresAt: new Date() });
    const response = await POST(request({ action: "verify", code: "12345678" }));
    expect(await response.json()).toMatchObject({ destination: "/connect/approve?code=ABCD" }); expect(mocks.setSession).toHaveBeenCalled();
  });
  it("rejects invalid codes and fails closed while email is unconfigured", async () => {
    expect((await POST(request({ action: "verify", code: "00000000" }))).status).toBe(400);
    expect(mocks.signIn).not.toHaveBeenCalled(); mocks.enabled.mockReturnValue(false);
    expect((await POST(request({ action: "send", email: "test@example.com" }))).status).toBe(503);
  });
});
