import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, loadConfig, saveConfig, updateConfig, installationId } from "./config.js";
let directory: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true }); directory = undefined; });
describe("atomic device config persistence", () => {
  it("shares an identity across clients and preserves it across re-enrollment", async () => {
    directory = await mkdtemp(join(tmpdir(), "usurp-install-test-"));
    vi.stubEnv("USURP_INSTALLATION_DIR", directory);
    const ids = await Promise.all(Array.from({ length: 8 }, () => installationId()));
    expect(new Set(ids).size).toBe(1);
    vi.stubEnv("USURP_CONFIG_DIR", join(directory, "other-client"));
    await saveConfig({ apiUrl: "https://usurp.example", seq: 1, deviceId: "new-device" });
    expect(await installationId()).toBe(ids[0]);
  });
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
