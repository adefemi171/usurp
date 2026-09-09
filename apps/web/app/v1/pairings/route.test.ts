import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }));
vi.mock("@usurp/db", () => ({ getDb: () => ({}), startPairing: mocks.start, pollPairing: mocks.poll, cancelPairing: mocks.cancel }));
vi.mock("../../../lib/env", () => ({ baseUrl: () => "https://usurp.example" }));
import { POST } from "./route";
const request = (body: unknown) => new Request("https://usurp.example/v1/pairings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => vi.resetAllMocks());
describe("pairing API boundaries", () => {
  it("rejects forms, oversized bodies, and malformed JSON without database writes", async () => {
    expect((await POST(new Request("https://usurp.example", { method: "POST", body: "action=start" }))).status).toBe(415);
    expect((await POST(request({ extra: "x".repeat(1025) }))).status).toBe(413);
    expect((await POST(request(null))).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("returns uncached pairing instructions for the configured origin", async () => {
    mocks.start.mockResolvedValue({ code: "ABCD-EF01-2345", token: "t".repeat(43), expiresAt: new Date(), interval: 5 });
    const response = await POST(request({ action: "start", publicKey: "a".repeat(43), label: "Computer" }));
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).verificationUri).toBe("https://usurp.example/connect/approve?code=ABCD-EF01-2345");
  });
  it("rate-limits rapid polling and hides internal database errors", async () => {
    mocks.poll.mockResolvedValue({ status: "slow_down" });
    expect((await POST(request({ action: "poll", token: "a".repeat(43) }))).status).toBe(429);
    mocks.start.mockRejectedValue(new Error("database-secret-detail"));
    const response = await POST(request({ action: "start", publicKey: "a".repeat(43), label: "Computer" }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("database-secret-detail");
  });
});
