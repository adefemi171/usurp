import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDeviceKeyPair, type Bucket, type IngestPayload } from "@usurp/protocol";
import type { Config } from "../config.js";
import { sync } from "./sync.js";
import { preview } from "./preview.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(), updateConfig: vi.fn(), loadKey: vi.fn(), collect: vi.fn(), ingest: vi.fn(), bridge: vi.fn(),
}));
vi.mock("@usurp/protocol", async original => ({ ...await original<typeof import("@usurp/protocol")>(), fetchBridgeSnapshot: mocks.bridge }));
vi.mock("../config.js", () => ({ loadConfig: mocks.loadConfig, updateConfig: mocks.updateConfig }));
vi.mock("../keystore.js", () => ({ loadKey: mocks.loadKey, KeystoreError: class extends Error {} }));
vi.mock("../api.js", () => ({ ApiClient: class { ingest = mocks.ingest; } }));
vi.mock("../collect.js", async (original) => ({
  ...await original<typeof import("../collect.js")>(), collect: mocks.collect,
}));
vi.mock("../ui.js", () => Object.fromEntries(
  ["bold", "compactNumber", "cyan", "dim", "error", "info", "success", "usd", "warn", "reserveStdoutForData"].map(k => [k, vi.fn()]),
));

describe("archive sync batching", () => {
  let config: Config;
  const bucket: Bucket = {
    hour: "2024-01-01T12:00:00Z", agent: "vscode-copilot", model: "claude-sonnet-4-6", historical: true,
    input_tokens: 18593, output_tokens: 287, cache_write_tokens: 0, cache_read_tokens: 0,
    calls: 1, sessions_started: 1, sessions_completed: 1, sessions_abandoned: 0,
    edits_applied: 0, edits_reverted: 0, commits: 0, cost_micros: 0, dedupe_key: "test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("USURP_AGENTS_VIEW_URL", "");
    config = { apiUrl: "http://localhost:3000", deviceId: "test", seq: 4, lastSyncAt: "2026-09-08T00:00:00Z" };
    mocks.loadConfig.mockImplementation(async () => ({ ...config }));
    mocks.updateConfig.mockImplementation(async patch => Object.assign(config, patch));
    mocks.loadKey.mockResolvedValue(generateDeviceKeyPair());
    mocks.collect.mockResolvedValue({ buckets: Array.from({ length: 1001 }, () => ({ ...bucket })), warnings: [] });
    mocks.ingest.mockImplementation(async (p: IngestPayload) => ({
      ok: true, data: { accepted: p.buckets.length, rejected: [], flags: [] },
    }));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("uploads a source-only snapshot without advancing or invoking native readers", async () => {
    const bridge = { source: "agentsview", schemaVersion: 6, fetchedAt: new Date().toISOString(), timezone: "UTC", pricingVersion: "v1", costBasis: "source-calculated", agents: ["codex"],
      rows: [{ day: "2026-09-09", agent: "codex", model: "model", inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costMicros: 10, costAvailable: true }] };
    mocks.bridge.mockResolvedValue(bridge);
    expect(await sync({ agentsview: "http://localhost:8080", bridgeOnly: true, quiet: true })).toBe(0);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.ingest.mock.calls[0]?.[0]).toMatchObject({ bridge, buckets: [] });
    expect(config.lastSyncAt).toBe("2026-09-08T00:00:00Z");
    expect(config.agentsviewUrl).toBe("http://localhost:8080");
  });

  it("continues native sync on bridge failure but returns a visible partial failure", async () => {
    mocks.bridge.mockRejectedValue(new Error("offline"));
    expect(await sync({ agentsview: "http://localhost:8080", quiet: true })).toBe(1);
    expect(mocks.ingest).toHaveBeenCalledTimes(3);
    expect(mocks.ingest.mock.calls.every(([p]) => !p.bridge)).toBe(true);
    expect(config.agentsviewUrl).toBeUndefined();
  });

  it("does not send anything when source-only refresh fails", async () => {
    mocks.bridge.mockRejectedValue(new Error("offline"));
    expect(await sync({ agentsview: "http://localhost:8080", bridgeOnly: true, quiet: true })).toBe(1);
    expect(mocks.collect).not.toHaveBeenCalled(); expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("includes the bridge in JSON preview without uploading or changing config", async () => {
    const bridge = { source: "agentsview", schemaVersion: 6, fetchedAt: new Date().toISOString(), timezone: "UTC", pricingVersion: "v1", costBasis: "source-calculated", agents: ["codex"],
      rows: [{ day: "2026-09-09", agent: "codex", model: "model", inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, costMicros: 10, costAvailable: true }] };
    mocks.bridge.mockResolvedValue(bridge);
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(await preview({ agentsview: "http://localhost:8080", bridgeOnly: true, json: true })).toBe(0);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ buckets: [], bridge });
      expect(mocks.ingest).not.toHaveBeenCalled(); expect(mocks.updateConfig).not.toHaveBeenCalled();
      expect(mocks.collect).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
  });

  it("submits bounded signed batches, advances each sequence, and preserves the incremental cursor", async () => {
    expect(await sync({ all: true, quiet: true })).toBe(0);
    const sent = mocks.ingest.mock.calls.map(([payload]) => payload as IngestPayload);
    expect(sent.map(p => p.buckets.length)).toEqual([500, 500, 1]);
    expect(sent.map(p => p.seq)).toEqual([4, 5, 6]);
    expect(sent.every(p => Boolean(p.sig) && p.buckets.every(b => b.historical))).toBe(true);
    expect(config.seq).toBe(7);
    expect(config.lastSyncAt).toBe("2026-09-08T00:00:00Z");
    expect(mocks.collect).toHaveBeenCalledWith(expect.objectContaining({ all: true }));
  });

  it("keeps accepted batch progress when a later batch fails", async () => {
    mocks.ingest.mockResolvedValueOnce({ ok: true, data: { accepted: 500, rejected: [], flags: [] } });
    mocks.ingest.mockResolvedValueOnce({ ok: false, status: 0, error: "network_error" });
    expect(await sync({ all: true, quiet: true })).toBe(1);
    expect(config.seq).toBe(5);
    expect(config.lastSyncAt).toBe("2026-09-08T00:00:00Z");
    expect(mocks.ingest).toHaveBeenCalledTimes(2);
  });

  it("does not advance the regular cursor for an empty archive", async () => {
    mocks.collect.mockResolvedValue({ buckets: [], warnings: [] });
    expect(await sync({ all: true, quiet: true })).toBe(0);
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("re-anchors stale sequence numbers before proceeding to the next batch", async () => {
    mocks.ingest.mockResolvedValueOnce({ ok: false, status: 409, error: "stale_seq", lastSeq: 8 });
    expect(await sync({ all: true, quiet: true })).toBe(0);
    expect(mocks.ingest.mock.calls.map(([p]) => p.seq)).toEqual([4, 9, 10, 11]);
  });
});
