import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), owned: vi.fn(), fetch: vi.fn(), save: vi.fn() }));
vi.mock("../../../../lib/session", () => ({ requireUser: mocks.auth }));
vi.mock("../../../../lib/bridge", () => ({ ownedBridge: mocks.owned }));
vi.mock("@usurp/protocol", () => ({ fetchBridgeSnapshot: mocks.fetch }));
vi.mock("@usurp/db", () => ({ getDb: () => ({}), saveOwnedBridge: mocks.save }));
import { POST } from "./route";
const request = (origin = "http://localhost:3000") => new Request("http://localhost:3000/api/usage/refresh", { method: "POST", headers: { origin } });
beforeEach(() => {
  vi.clearAllMocks(); process.env.USURP_BASE_URL = "http://localhost:3000";
  mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner" } });
  mocks.owned.mockResolvedValue({ url: "http://localhost:8080", deviceId: "device" });
  mocks.fetch.mockResolvedValue({ source: "agentsview" }); mocks.save.mockResolvedValue(true);
});
describe("owner-only source refresh", () => {
  it("refuses cross-origin requests before network or writes", async () => {
    expect((await POST(request("https://untrusted.example"))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("requires sign-in", async () => {
    mocks.auth.mockResolvedValue({ ok: false }); expect((await POST(request())).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("requires ownership of the configured device", async () => {
    mocks.owned.mockResolvedValue(null); expect((await POST(request())).status).toBe(409);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("leaves the last snapshot untouched when the source fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline")); const r = await POST(request());
    expect(r.status).toBe(502); expect((await r.json()).message).toContain("last successful snapshot");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("imports only into the authenticated owner's configured device", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({}, "owner", "device", { source: "agentsview" });
  });
});
