import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { verifyOutcome } from "../../packages/protocol/src/outcomes.js";
import { outcomeCommand, readOutcomes, syncOutcomes, prPassed } from "./outcomes.js";
const { keys } = vi.hoisted(() => ({ keys: new Map<string, string>() }));
vi.mock("../../packages/cli/src/keystore.js", () => ({ saveKey: async (id: string, key: string) => { keys.set(id, key); }, loadKey: async (id: string) => { if (!keys.has(id)) throw new Error("missing"); return { privateKeyPem: keys.get(id)! }; } }));
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "usurp-outcomes-")); vi.spyOn(console, "log").mockImplementation(() => {}); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("offline"); })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("offline outcome lifecycle", () => {
  it("does not pass signing secrets to the measured command", async () => {
    const id = randomUUID(); await outcomeCommand(["mission-start", "--id", id], directory);
    await outcomeCommand(["attest", "--mission", id, "--", process.execPath, "-e", "process.exit(0)"], directory);
    vi.stubEnv("USURP_DEVICE_KEY", "a-secret-that-must-not-reach-child");
    expect(await outcomeCommand(["attest", "--mission", id, "--", process.execPath, "-e", "process.exit(process.env.USURP_DEVICE_KEY ? 7 : 0)"], directory)).toBe(0);
  });
  it("starts and verifies without an account or network, preserves failures and enforces the check limit", async () => {
    const id = randomUUID();
    await outcomeCommand(["mission-start", "--id", id, "--label", "private label", "--max-runs", "2"], directory);
    expect(await outcomeCommand(["attest", "--mission", id, "--", process.execPath, "-e", "process.exit(0)"], directory)).toBe(0);
    expect(await outcomeCommand(["attest", "--mission", id, "--", process.execPath, "-e", "process.exit(1)"], directory)).toBe(1);
    const records = await readOutcomes(directory);
    expect(records).toHaveLength(2); expect(records.every(verifyOutcome)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private label"); expect(JSON.stringify(records)).not.toContain("process.exit");
    expect(fetch).not.toHaveBeenCalled();
    await expect(outcomeCommand(["attest", "--mission", id, "--", process.execPath, "-e", "process.exit(0)"], directory)).rejects.toThrow("limit");
    await expect(syncOutcomes(directory, "https://usurp.example")).rejects.toThrow("offline");
    expect(await readOutcomes(directory)).toEqual(records);
    const request = vi.fn(async (_url, init) => Response.json({ accepted: JSON.parse(init.body).outcome.id }));
    expect(await syncOutcomes(directory, "https://usurp.example", request as typeof fetch)).toBe(2);
    expect(await syncOutcomes(directory, "https://usurp.example", request as typeof fetch)).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readOutcomes(directory)).toHaveLength(2);
  });
  it("does not acknowledge a rejected response or altered acknowledgement", async () => {
    const id = randomUUID(); await outcomeCommand(["mission-start", "--id", id], directory);
    await outcomeCommand(["attest", "--mission", id, "--", process.execPath, "-e", "process.exit(0)"], directory);
    await expect(syncOutcomes(directory, "https://usurp.example", async () => Response.json({ accepted: "wrong" }))).rejects.toThrow("acknowledgement");
    const request = vi.fn(async (_url, init) => Response.json({ accepted: JSON.parse(init.body).outcome.id }));
    expect(await syncOutcomes(directory, "https://usurp.example", request as typeof fetch)).toBe(1);
    const marker = await readFile(join(directory, "outcome-key.json"), "utf8");
    expect(marker).not.toContain("PRIVATE");
  });
  it("does not treat absent, pending, skipped, malformed or failed PR checks as a pass", () => {
    const good = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
    expect(prPassed({ mergedAt: new Date().toISOString(), statusCheckRollup: [good] })).toBe(true);
    for (const rollup of [[], [{ ...good, conclusion: "SKIPPED" }], [{ ...good, status: "IN_PROGRESS" }], [null], [good, { __typename: "StatusContext", state: "FAILURE" }]]) {
      expect(prPassed({ mergedAt: new Date().toISOString(), statusCheckRollup: rollup })).toBe(false);
    }
    expect(prPassed({ mergedAt: null, statusCheckRollup: [good] })).toBe(false);
  });
});
