import { _electron } from "playwright";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "usurp-packaged-test-"));
const executablePath = resolve("release/mac-arm64/Usurp Connect.app/Contents/MacOS/Usurp Connect");
const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${root}`, "--background"], timeout: 20_000 });
try {
  const state = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, data: app.getPath("userData") }));
  assert.equal(state.packaged, true); assert.equal(await realpath(state.data), await realpath(root));
  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForFunction(() => document.querySelector("#status").textContent !== "Starting…");
  const exposed = await window.evaluate(() => window.connect.state());
  assert.equal(exposed.ok, true); assert.equal(exposed.value.deviceId, undefined); assert.deepEqual(exposed.value.agents, []);
  assert.equal(await window.evaluate(() => typeof window.require), "undefined");
  // Load the native module from inside the packaged ASAR, not the checkout.
  const native = await app.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule("module");
    const require = createRequire(`${app.getAppPath()}/package.json`);
    const { Entry } = require("@napi-rs/keyring");
    const { randomUUID } = require("node:crypto");
    const entry = new Entry("usurp-connect-package-test", randomUUID());
    try { entry.setPassword("synthetic-test-value"); return entry.getPassword() === "synthetic-test-value"; }
    finally { entry.deletePassword(); }
  });
  assert.equal(native, true);
  console.log(JSON.stringify({ passed: true, tests: ["packaged app launch", "isolated app data", "renderer sandbox", "no default collection consent", "packaged native keychain roundtrip"], artifact: executablePath }));
} finally { await app.close(); }
