import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ detect: vi.fn().mockResolvedValue(true), read: vi.fn().mockResolvedValue({ calls: [], sessions: [], edits: [], warnings: [] }) }));
vi.mock("@usurp/readers", async original => ({ ...await original<typeof import("@usurp/readers")>(), defaultReaders: () => ["codex", "cursor", "claude-code", "vscode-copilot"].map(id => ({ id, detect: () => mocks.detect(id), read: () => mocks.read(id) })) }));
import { collect } from "./collect.js";
describe("reader consent", () => {
  it("does not even detect unselected sources", async () => {
    vi.clearAllMocks(); await collect({ deviceId: "test", agents: ["cursor"], noGit: true });
    expect(mocks.detect.mock.calls).toEqual([["cursor"]]); expect(mocks.read.mock.calls).toEqual([["cursor"]]);
  });
  it("an empty list reads no native sources", async () => {
    vi.clearAllMocks(); await collect({ deviceId: "test", agents: [], noGit: true });
    expect(mocks.detect).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
});
