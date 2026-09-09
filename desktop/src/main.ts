import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray, utilityProcess } from "electron";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { generateDeviceKeyPair } from "../../packages/protocol/src/keys.js";
import { loadConfig, saveConfig } from "../../packages/cli/src/config.js";
import { loadKey, saveKey, deleteKey } from "../../packages/cli/src/keystore.js";
import { AGENTS, deepLinkServer, serverOrigin, sourceSelection } from "./policy.js";
declare const CONNECT_SIGNED_RELEASE: boolean;

// The desktop app never inherits CLI credentials, a different deployment, or a bridge.
for (const name of Object.keys(process.env)) if (name.startsWith("USURP_")) delete process.env[name];
process.env.USURP_CONFIG_DIR = join(app.getPath("userData"), "device");
const uiUrl = pathToFileURL(join(__dirname, "index.html")).href;
const preferencesPath = join(app.getPath("userData"), "preferences.json");
const pendingAccount = `connect-pairing-${createHash("sha256").update(app.getPath("userData")).digest("hex").slice(0,16)}`;
type Preferences = { server: string; agents: string[]; bridge: boolean; all: boolean; paused: boolean; consent: boolean; launchAtLogin: boolean; lastSuccess?: string; imported?: boolean };
let prefs: Preferences = { server: "https://usurp.onrender.com", agents: [], bridge: false, all: false, paused: true, consent: false, launchAtLogin: false };
type Pending = { code: string; token: string; publicKey: string; expiresAt: string; server: string };
let pending: Pending | undefined;
let window: BrowserWindow | undefined, tray: Tray, quitting = false, busy = false, polling = false, pairing = false;
let status = "Choose your website, then connect your account.", warning = "", nextSync = 0, failures = 0;
let updateStatus = "Updates are not enabled in this preview build.";
let checkUpdates: () => Promise<unknown> = () => shell.openExternal("https://github.com/adefemi171/usurp/releases");
let preferencesWrite = Promise.resolve();
async function persist() {
  preferencesWrite = preferencesWrite.catch(() => {}).then(async () => {
    await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
    await writeFile(`${preferencesPath}.tmp`, JSON.stringify(prefs), { mode: 0o600 });
    await rename(`${preferencesPath}.tmp`, preferencesPath);
  });
  return preferencesWrite;
}
async function api(body: unknown, origin = prefs.server) {
  const response = await fetch(`${origin}/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok && response.status !== 429) throw new Error("The website could not complete pairing. Check the address and try again.");
  return response.json();
}
async function clearPending() {
  if (pending) await deleteKey(`connect-pending-${pending.publicKey}`);
  await deleteKey(pendingAccount);
  pending = undefined;
}
async function pair() {
  if (pairing || pending || (await loadConfig()).deviceId) throw new Error("Already connected or awaiting approval.");
  pairing = true;
  const keys = generateDeviceKeyPair();
  try {
    await saveKey(`connect-pending-${keys.publicKey}`, keys.privateKeyPem);
    const response = await api({ action: "start", publicKey: keys.publicKey, label: hostname().slice(0, 64) });
    if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(response.code) || !/^[A-Za-z0-9_-]{43}$/.test(response.token) || !Number.isFinite(Date.parse(response.expiresAt))) throw new Error("Invalid pairing response.");
    pending = { code: response.code, token: response.token, publicKey: keys.publicKey, expiresAt: response.expiresAt, server: prefs.server };
    await saveKey(pendingAccount, JSON.stringify(pending));
    status = "Approve the matching code in your browser. No data is syncing yet.";
    await shell.openExternal(`${prefs.server}/connect/approve?code=${encodeURIComponent(pending.code)}`);
  } catch (error) { await clearPending(); await deleteKey(`connect-pending-${keys.publicKey}`); throw error; }
  finally { pairing = false; }
}
async function poll() {
  if (!pending || polling || pairing) return;
  polling = true;
  try {
    if (Date.parse(pending.expiresAt) <= Date.now()) { await clearPending(); status = "Pairing expired. Connect again."; return; }
    const result = await api({ action: "poll", token: pending.token }, pending.server);
    if (result.status === "approved") {
      if (!/^dev_[A-Z0-9]+$/.test(result.deviceId) || typeof result.handle !== "string") throw new Error("Invalid device response.");
      const key = await loadKey(`connect-pending-${pending.publicKey}`);
      await saveKey(result.deviceId, key.privateKeyPem);
      await saveConfig({ apiUrl: pending.server, deviceId: result.deviceId, handle: result.handle, seq: 1 });
      await clearPending();
      status = "Connected. Choose your sources and start syncing.";
    } else if (["denied", "expired"].includes(result.status)) { await clearPending(); status = "Connection declined or expired. You can try again."; }
  } catch { status = "Waiting for the website. Pairing will retry automatically."; }
  finally { polling = false; }
}
async function runSync() {
  if (busy) return;
  if (prefs.paused || !prefs.consent) throw new Error("Save your choices and start syncing first.");
  if (!prefs.agents.length && !prefs.bridge) throw new Error("Choose at least one source.");
  busy = true;
  if (!(await loadConfig()).deviceId) { busy = false; throw new Error("Connect your account first."); }
  warning = ""; status = "Reading selected sources and syncing…";
  const snapshot = { agents: prefs.agents, bridge: prefs.bridge, all: prefs.all && !prefs.imported };
  let child: ReturnType<typeof utilityProcess.fork>;
  try { child = utilityProcess.fork(join(__dirname, "sync-worker.cjs"), [], { env: process.env, stdio: "ignore", serviceName: "Usurp usage sync" }); }
  catch { busy = false; throw new Error("Could not start the local sync process."); }
  let settled = false;
  const finish = async (result: { ok: boolean; warnings?: number }) => {
    if (settled) return; settled = true; clearTimeout(timeout); child.kill();
    try {
      if (result.ok) {
        failures = 0; prefs.lastSuccess = new Date().toISOString(); if (snapshot.all) prefs.imported = true;
        status = "Sync complete. Your dashboard is up to date with available local records.";
        warning = result.warnings ? "Some records have reader or pricing warnings. Review data quality on your dashboard." : "";
        await persist();
      } else { failures++; status = "Sync incomplete. Retrying automatically."; warning = "Check your connection, source access, and whether this device was revoked in Settings."; }
    } finally { nextSync = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** failures); busy = false; }
  };
  const timeout = setTimeout(() => void finish({ ok: false }), 15 * 60_000);
  child.on("message", result => void finish(result));
  child.on("exit", () => void finish({ ok: false }));
  child.postMessage(snapshot);
}
function show() { if (window) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ show: !app.commandLine.hasSwitch("background"), width: 840, height: 850, minWidth: 640, minHeight: 650, backgroundColor: "#101416", title: "Usurp Connect", webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("close", event => { if (!quitting) { event.preventDefault(); window!.hide(); } });
  void window.loadURL(uiUrl);
}
async function offerServer(link: string) {
  try {
    const server = deepLinkServer(link); show();
    if ((await loadConfig()).deviceId || pending) { status = "Already connected or pairing. Disconnect before switching websites."; return; }
    const result = await dialog.showMessageBox(window!, { type: "question", title: "Connect to this website?", message: `Use ${server}?`, detail: "Only continue if this is the Usurp deployment you trust. No usage will be uploaded until you approve sources.", buttons: ["Cancel", "Use website"], defaultId: 0, cancelId: 0 });
    if (result.response === 1) { prefs.server = server; await persist(); }
  } catch { status = "That Connect link is not valid."; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, args) => { show(); const link = args.find(arg => arg.startsWith("usurp-connect:")); if (link) void offerServer(link); });
  app.on("open-url", (event, link) => { event.preventDefault(); void app.whenReady().then(() => offerServer(link)); });
  app.on("before-quit", () => { quitting = true; });
  app.on("activate", show);
  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    try { const stored = JSON.parse(await readFile(preferencesPath, "utf8")); prefs = { ...prefs, ...stored, server: serverOrigin(stored.server), agents: sourceSelection(stored.agents) }; } catch { /* safe initial setup */ }
    try { pending = JSON.parse((await loadKey(pendingAccount)).privateKeyPem); if (pending) pending.server = serverOrigin(pending.server); } catch { pending = undefined; }
    if ((await loadConfig()).deviceId) { await clearPending(); status = prefs.paused ? "Sync is paused." : "Connected. Automatic sync is enabled."; }
    if (app.isPackaged) app.setAsDefaultProtocolClient("usurp-connect");
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Usurp Connect", submenu: [{ label: "Show Usurp Connect", click: show }, { role: "quit" }] }, { role: "editMenu" }]));
    const icon = nativeImage.createFromDataURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGElEQVR42mP8v5ThPwMlgImBQjBqAOMBBgDYtwMNIPfYLQAAAABJRU5ErkJggg==");
    tray = new Tray(icon); tray.setToolTip("Usurp Connect"); tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open Usurp Connect", click: show }, { label: "Quit", click: () => app.quit() }])); tray.on("click", show);
    const handle = (name: string, fn: (value?: any) => unknown) => ipcMain.handle(`connect:${name}`, async (event, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) throw new Error("Untrusted caller");
      try { return { ok: true, value: await fn(value) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Operation failed." }; }
    });
    handle("state", async () => { const config = await loadConfig(); return { ...prefs, deviceId: config.deviceId, handle: config.handle, busy, status, warning, updateStatus, pairing: pending ? { code: pending.code, fingerprint: createHash("sha256").update(pending.publicKey).digest("hex").slice(0,16), expiresAt: pending.expiresAt } : null }; });
    handle("save", async value => {
      if (busy || pairing || polling) throw new Error("Wait for the current operation to finish.");
      const server = serverOrigin(value.server), agents = sourceSelection(value.agents);
      if (((await loadConfig()).deviceId || pending) && server !== prefs.server) throw new Error("Disconnect before changing websites.");
      if (["bridge", "all", "launchAtLogin", "consent"].some(key => typeof value[key] !== "boolean")) throw new Error("Invalid preferences.");
      if (value.consent && !agents.length && !value.bridge) throw new Error("Choose at least one source.");
      const changed = JSON.stringify(agents) !== JSON.stringify(prefs.agents) || value.all !== prefs.all;
      prefs = { ...prefs, server, agents, bridge: value.bridge, all: value.all, launchAtLogin: value.launchAtLogin, consent: value.consent, paused: !value.consent, imported: changed ? false : prefs.imported };
      if (changed) { const config = await loadConfig(); delete config.lastSyncAt; await saveConfig(config); }
      if (process.platform !== "linux" && app.isPackaged) app.setLoginItemSettings({ openAtLogin: prefs.launchAtLogin });
      await persist(); nextSync = 0; status = prefs.paused ? "Preferences saved. Sync is paused." : "Preferences saved. Automatic sync is enabled.";
    });
    handle("pair", pair);
    handle("cancel", async () => {
      if (pairing || polling) throw new Error("Wait a moment, then cancel again.");
      if (!pending) return;
      polling = true;
      try {
        const result = await api({ action: "cancel", token: pending.token }, pending.server);
        if (!result.cancelled) { status = "The browser already approved this computer. Finishing connection; you can then disconnect."; return; }
        await clearPending(); status = "Pairing cancelled.";
      } finally { polling = false; }
    });
    handle("sync", runSync);
    handle("pause", async () => { prefs.paused = true; await persist(); status = busy ? "Pausing after this in-flight sync completes." : "Sync is paused."; });
    handle("disconnect", async () => {
      if (busy || polling || pairing) throw new Error("Wait for the current operation to finish before disconnecting.");
      const result = await dialog.showMessageBox(window!, { type: "warning", message: "Disconnect this computer?", detail: "This deletes the local key and stops syncing. Previously uploaded usage remains. Revoke the device on the website to invalidate any copies of its key.", buttons: ["Cancel", "Disconnect"], defaultId: 0, cancelId: 0 });
      if (result.response !== 1) return;
      prefs.paused = true; prefs.consent = false; prefs.imported = false; delete prefs.lastSuccess; await persist();
      const config = await loadConfig();
      if (config.deviceId) {
        const keyExists = await loadKey(config.deviceId).then(() => true, () => false);
        if (keyExists && !(await deleteKey(config.deviceId))) throw new Error("The keychain refused to delete the key. Sync is paused; revoke the device on the website and try again.");
      }
      await clearPending(); await saveConfig({ apiUrl: prefs.server, seq: 1 }); status = "Disconnected. Revoke the old device in website Settings.";
    });
    handle("dashboard", () => shell.openExternal(`${prefs.server}/settings#devices`));
    // macOS update verification requires a signed app. Preview and Linux builds
    // never download executable updates; they offer the release page instead.
    if (CONNECT_SIGNED_RELEASE && app.isPackaged && process.platform === "darwin") {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.autoDownload = false; autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.setFeedURL({ provider: "github", owner: "adefemi171", repo: "usurp" });
      autoUpdater.on("error", () => { updateStatus = "Update check failed. Your current app is unchanged."; });
      autoUpdater.on("update-not-available", () => { updateStatus = "You have the latest version."; });
      autoUpdater.on("update-available", () => { updateStatus = "An update is available. Choose Releases to download it."; checkUpdates = () => autoUpdater.downloadUpdate(); });
      autoUpdater.on("update-downloaded", () => { updateStatus = "Update ready. Choose Releases to restart and install."; checkUpdates = async () => { if (busy) throw new Error("Wait for sync to finish before restarting."); quitting = true; autoUpdater.quitAndInstall(); }; });
      checkUpdates = () => autoUpdater.checkForUpdates();
      void checkUpdates().catch(() => {});
    }
    handle("update", () => checkUpdates());
    show();
    const link = process.argv.find(arg => arg.startsWith("usurp-connect:")); if (link) await offerServer(link);
    setInterval(() => { void poll(); if (!prefs.paused && prefs.consent && !pending && Date.now() >= nextSync) void runSync().catch(() => {}); }, 5500);
  }).catch(() => { dialog.showErrorBox("Usurp Connect could not start", "Check that the app can access its application data folder and OS keychain."); app.quit(); });
}
