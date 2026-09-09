import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, loadConfig, saveConfig, updateConfig } from "./config.js";
let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true }); directory = undefined; });
describe("atomic device config persistence", () => {
  it("retains identity while updating a sequence and restricts file permissions", async () => {
    directory = await mkdtemp(join(tmpdir(), "usurp-config-test-"));
    vi.stubEnv("USURP_CONFIG_DIR", directory);
    await saveConfig({ apiUrl: "https://usurp.example", deviceId: "dev_test", seq: 1 });
    await updateConfig({ seq: 2 });
    expect(await loadConfig()).toMatchObject({ deviceId: "dev_test", seq: 2 });
    expect(JSON.parse(await readFile(configPath(), "utf8"))).toMatchObject({ apiUrl: "https://usurp.example" });
    if (process.platform !== "win32") expect((await stat(configPath())).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["config.json"]);
  });
});
