import { describe, expect, it, vi } from "vitest";
import { bridgeSnapshotSchema, bridgeUrl, fetchBridgeSnapshot } from "./bridge.js";
import { generateDeviceKeyPair, payloadSchema, signPayload, verifyPayload } from "./index.js";

const counters = { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 500 };
function response() { return {
  schema_version: 6, totals: { ...counters, totalCost: { microdollars: 123456 } },
  agentTotals: [{ agent: "codex" }],
  daily: [{ date: "2026-09-01", ...counters, totalCost: { microdollars: 123456 },
    modelBreakdowns: [{ modelName: "test-model", ...counters, cost: { microdollars: 123456 } }],
    projectBreakdowns: [{ privateProject: "DO_NOT_UPLOAD" }] }],
  pricing: { table_version: "historical-v1", models: { "test-model": { cost_source: "computed", resolutions: [{ matched_pattern: "test-model" }] } } },
  sessionCounts: { privateSession: "DO_NOT_UPLOAD" },
}; }
const mockFetch = () => vi.fn(async () => new Response(JSON.stringify(response()))) as unknown as typeof fetch;

describe("AgentsView bridge", () => {
  it("imports source money unchanged and excludes private fields", async () => {
    const request = mockFetch(); const s = await fetchBridgeSnapshot("http://localhost:8080", request);
    expect(s.rows[0]).toMatchObject({ costMicros: 123456, cacheReadTokens: 500, costAvailable: true });
    expect(s.sourceId).toBe("agentsview:local:8080");
    expect(s.rows).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain("DO_NOT_UPLOAD");
    expect(JSON.stringify(s)).not.toContain("calls");
    expect(vi.mocked(request).mock.calls[1]?.[0].toString()).toContain("agent=codex");
  });
  it("rejects changed or incomplete totals", async () => {
    const bad = response(); bad.daily[0]!.modelBreakdowns[0]!.cost.microdollars = 1;
    await expect(fetchBridgeSnapshot("http://localhost:8080", vi.fn(async () => new Response(JSON.stringify(bad))))).rejects.toThrow("reconcile");
  });
  it("rejects incompatible schema versions", async () => {
    await expect(fetchBridgeSnapshot("http://localhost:8080", vi.fn(async () => new Response(JSON.stringify({ ...response(), schema_version: 7 }))))).rejects.toThrow();
  });
  it("fails cleanly when offline", async () => {
    await expect(fetchBridgeSnapshot("http://localhost:8080", vi.fn(async () => { throw new Error("offline"); }))).rejects.toThrow("offline");
  });
  it("limits bridge origins and disallows credentials / remote URLs", () => {
    for (const url of ["https://example.com", "http://user:secret@localhost:8080", "file:///etc/passwd", "http://localhost:8080/private", "http://127.0.0.1.evil.test"])
      expect(() => bridgeUrl(url)).toThrow();
    expect(bridgeUrl("http://host.docker.internal:8080").hostname).toBe("host.docker.internal");
  });
  it("preserves the local service authority through Docker's transport", async () => {
    const request = mockFetch(); await fetchBridgeSnapshot("http://host.docker.internal:8080", request);
    expect(vi.mocked(request).mock.calls[0]?.[1]).toMatchObject({ redirect: "error", headers: { host: "localhost:8080" } });
  });
  it("gives local aliases the same source identity", async () => {
    const local = await fetchBridgeSnapshot("http://localhost:8080", mockFetch());
    const loopback = await fetchBridgeSnapshot("http://127.0.0.1:8080", mockFetch());
    expect(loopback.sourceId).toBe(local.sourceId);
  });
  it("signs the snapshot including costs and timestamps", async () => {
    const bridge = await fetchBridgeSnapshot("http://localhost:8080", mockFetch());
    const keys = generateDeviceKeyPair();
    const signed = signPayload({ v: 1, device_id: "dev_test", seq: 1, submitted_at: bridge.fetchedAt, buckets: [], bridge }, keys.privateKeyPem);
    expect(payloadSchema.safeParse(signed).success).toBe(true);
    expect(verifyPayload(signed, keys.publicKey)).toBe(true);
    const tampered = structuredClone(signed); tampered.bridge!.rows[0]!.costMicros++;
    expect(verifyPayload(tampered, keys.publicKey)).toBe(false);
  });
  it("refuses duplicate keys, fractional money, unknown fields, impossible dates", async () => {
    const s = await fetchBridgeSnapshot("http://localhost:8080", mockFetch());
    for (const rows of [[...s.rows, ...s.rows], [{ ...s.rows[0], costMicros: 1.5 }], [{ ...s.rows[0], prompt: "secret" }], [{ ...s.rows[0], day: "2026-02-30" }]])
      expect(bridgeSnapshotSchema.safeParse({ ...s, rows }).success).toBe(false);
  });
  it("does not classify an unknown zero cost as free", async () => {
    const data = response(); data.totals.totalCost.microdollars = 0; data.daily[0]!.modelBreakdowns[0]!.cost.microdollars = 0;
    data.pricing.models["test-model"].resolutions = [];
    const s = await fetchBridgeSnapshot("http://localhost:8080", vi.fn(async () => new Response(JSON.stringify(data))));
    expect(s.rows[0]!.costAvailable).toBe(false);
  });
});
