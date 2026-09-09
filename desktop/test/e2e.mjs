import { _electron, chromium } from "playwright";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";

const website = "http://localhost:3107";
const root = await mkdtemp(join(tmpdir(), "usurp-connect-e2e-"));
const fixtures = join(root, "fixtures");
await mkdir(join(fixtures, ".codex", "sessions"), { recursive: true });
const timestamp = new Date(Date.now() - 3600_000).toISOString();
await writeFile(join(fixtures, ".codex", "sessions", "rollout.jsonl"), [
  { timestamp, type: "session_meta", payload: { id: "connect-synthetic-test" } },
  { timestamp, type: "turn_context", payload: { model: "gpt-5.6-sol" } },
  { timestamp, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 }, total_token_usage: { total_tokens: 1010 } } } },
].map(JSON.stringify).join("\n"));
let electron, browser, page;
const launch = async () => {
  electron = await _electron.launch({ timeout: 20000, ...(process.env.CONNECT_ELECTRON_EXECUTABLE ? { executablePath: process.env.CONNECT_ELECTRON_EXECUTABLE } : {}), args: [resolve("test/launch.cjs"), "--background"], env: { ...process.env, CONNECT_TEST_DATA_DIR: join(root, "app"), CONNECT_TEST_FIXTURES: fixtures } });
  page = await electron.firstWindow({ timeout: 20000 }); page.setDefaultTimeout(20000); await page.waitForSelector("#pair");
  await page.waitForFunction(() => document.querySelector("#status").textContent !== "Starting…");
};
try {
  await launch();
  console.log("Desktop window initialized");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.locator('[name="agent"]:checked').count(), 0);
  await page.locator("#server").fill(website);
  assert.equal(await page.locator("#server").inputValue(), website);
  await page.locator("#pair").click();
  await page.waitForFunction(() => document.querySelector("#code").textContent.length > 0, undefined, { timeout: 30_000 });
  const code = await page.locator("#code").textContent();
  console.log("Pairing request created; secret stays outside renderer");
  const link = await electron.evaluate(() => global.__connectOpenedLinks.at(-1));
  assert.equal(new URL(link).origin, website);
  assert.equal(new URL(link).searchParams.get("code"), code);
  const publicState = await page.evaluate(() => window.connect.state());
  assert.equal("token" in publicState.value.pairing, false);
  // Restart before approval: both pending token and key survive in the OS keychain.
  await electron.close(); await launch();
  assert.equal(await page.locator("#code").textContent(), code);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const web = await browser.newPage();
  await web.goto(link);
  await web.getByRole("link", { name: "Developer sign-in (local only)" }).click();
  const handle = `connect_${Date.now().toString(36)}`;
  await web.getByRole("textbox", { name: "Handle" }).fill(handle);
  await web.getByRole("button", { name: "Sign in", exact: true }).click();
  await web.getByRole("heading", { name: "Is this your code?" }).waitFor();
  assert.ok((await web.locator("main").innerText()).includes(code));
  await web.getByRole("button", { name: "Yes, connect this computer" }).click();
  await web.getByRole("heading", { name: "Computer connected." }).waitFor();
  console.log("Browser approval completed");
  await page.waitForFunction(() => document.querySelector("#identity").textContent.includes("Connected as"));
  await page.locator('[name="agent"][value="codex"]').check();
  await page.locator("#consent").check();
  await writeFile(join(fixtures, "fail-next-upload"), "synthetic test only");
  await page.locator("#save").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent.includes("Sync incomplete"));
  const failedConfig = JSON.parse(await readFile(join(root, "app", "device", "config.json"), "utf8"));
  assert.equal(failedConfig.seq, 1); assert.equal(failedConfig.lastSyncAt, undefined);
  // Advance only the main-process scheduling clock to exercise automatic retry
  // without waiting two minutes; the worker's signed timestamps remain real.
  await electron.evaluate(() => { global.__connectClock = Date.now; Date.now = () => global.__connectClock() + 180_000; });
  await page.waitForFunction(() => document.querySelector("#last-sync").textContent.startsWith("Last successful sync"), undefined, { timeout: 45_000 });
  await electron.evaluate(() => { Date.now = global.__connectClock; });
  console.log("Offline failure and automatic retry verified");
  const config = JSON.parse(await readFile(join(root, "app", "device", "config.json"), "utf8"));
  assert.ok(config.seq > 1); assert.equal(config.handle, handle);
  assert.ok(!JSON.stringify(config).includes("PRIVATE KEY"));
  await web.goto(`${website}/u/${handle}?window=all`);
  const profile = await web.locator("main").innerText();
  assert.ok(profile.includes("Codex") || profile.includes("codex"));
  assert.ok(profile.includes("110") && profile.includes("900") && profile.includes("1 native calls"));
  await page.locator("#pause").click();
  await page.waitForFunction(() => document.querySelector("#badge").textContent === "Paused");
  await electron.close(); await launch();
  assert.equal(await page.locator("#badge").textContent(), "Paused");
  await page.screenshot({ path: join(root, "companion.png"), fullPage: true });
  await web.screenshot({ path: join(root, "profile.png"), fullPage: true });
  // Delete only this test device's key, and revoke it in the test database via UI.
  await web.goto(`${website}/settings#devices`);
  await web.getByRole("button", { name: "Revoke", exact: true }).click();
  await web.getByText("revoked", { exact: true }).waitFor();
  await electron.evaluate(async ({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
  await page.locator("#disconnect").click();
  await page.waitForFunction(() => document.querySelector("#badge").textContent === "Not connected");
  console.log(JSON.stringify({ passed: true, tested: ["renderer isolation", "source consent", "OS keychain persistence", "first-time browser sign-in return", "approval", "offline failure and automatic retry", "signed synthetic Codex sync", "exact fixture totals", "pause persistence", "revocation", "disconnect"], artifacts: root }));
} catch (error) {
  if (page && !page.isClosed()) { console.error("Desktop status:", await page.locator("#status").textContent(), "UI error:", await page.locator("#error").textContent()); await page.screenshot({ path: join(root, "failure.png"), fullPage: true }).catch(() => {}); }
  console.error("Test artifacts:", root); throw error;
} finally { if (electron) await electron.close().catch(() => {}); if (browser) await browser.close(); }
