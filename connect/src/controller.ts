import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { generateDeviceKeyPair } from "../../packages/protocol/src/keys.js";
import { loadConfig, saveConfig } from "../../packages/cli/src/config.js";
import { loadKey, saveKey, deleteKey } from "../../packages/cli/src/keystore.js";
import { serverOrigin, sourceSelection, cleanEnvironment } from "./policy.js";

type Preferences = { server: string; agents: string[]; bridge: boolean; all: boolean; consent: boolean; paused: boolean; imported: boolean; lastAttempt?: string; lastUpload?: string };
type Pending = { code: string; token: string; publicKey: string; expiresAt: string; server: string };
export type SyncResult = { ok: boolean; uploaded: boolean; warnings: number; batches?: number };
export class Controller {
  prefs: Preferences = { server: "https://usurp.onrender.com", agents: [], bridge: false, all: false, consent: false, paused: true, imported: false };
  pending?: Pending;
  busy = false;
  status = "Connect an account. Nothing is being collected or uploaded.";
  warning = "";
  nextSync = 0;
  failures = 0;
  private locked = false;
  private stopped = false;
  private child?: ReturnType<typeof fork>;
  private account: string;
  private writes = Promise.resolve();
  constructor(readonly directory: string, private readonly runner?: (options: { agents: string[]; bridge: boolean; all: boolean }) => Promise<SyncResult>) {
    this.account = `connect-service-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
  }
  async init() {
    process.env.USURP_CONFIG_DIR = join(this.directory, "device");
    try {
      const p = JSON.parse(await readFile(join(this.directory, "preferences.json"), "utf8"));
      if (["bridge", "all", "consent", "paused", "imported"].some(k => typeof p[k] !== "boolean")) throw new Error();
      this.prefs = { ...this.prefs, ...p, server: serverOrigin(p.server), agents: sourceSelection(p.agents) };
    } catch { /* unreadable preferences never enable collection */ }
    try { const p = JSON.parse((await loadKey(this.account)).privateKeyPem); this.pending = { ...p, server: serverOrigin(p.server) }; } catch { /* no pending approval */ }
    const c = await loadConfig();
    if (c.deviceId) { this.prefs.server = serverOrigin(c.apiUrl); await this.clearPending(); this.status = this.prefs.paused ? "Connected. Sync is paused." : "Connected. Automatic sync is enabled."; }
    else if (this.pending) { this.prefs.server = this.pending.server; this.status = "Waiting for browser approval. No data is syncing yet."; }
  }
  async persist() {
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(join(this.directory, "preferences.tmp"), JSON.stringify(this.prefs), { mode: 0o600 });
      await rename(join(this.directory, "preferences.tmp"), join(this.directory, "preferences.json"));
    });
    await this.writes;
  }
  async state() {
    const c = await loadConfig();
    return { ...this.prefs, deviceId: c.deviceId, handle: c.handle, busy: this.busy, status: this.status, warning: this.warning,
      nextSync: this.nextSync, pairing: this.pending ? { code: this.pending.code, expiresAt: this.pending.expiresAt,
        url: `${this.pending.server}/connect/approve?code=${encodeURIComponent(this.pending.code)}` } : null };
  }
  private async api(body: unknown, origin = this.prefs.server) {
    const r = await fetch(`${origin}/v1/pairings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(r.status === 429 ? "Too many pairing attempts. Wait a minute and try again." : "The website could not complete pairing. Check the address and connection.");
    return r.json();
  }
  private async clearPending() {
    if (this.pending) await deleteKey(`connect-pending-${this.pending.publicKey}`);
    await deleteKey(this.account); this.pending = undefined;
  }
  async action(name: string, value: any = {}) {
    if (this.locked) throw new Error("An operation is in progress. Please try again shortly.");
    this.locked = true;
    try {
      if (name === "pause") { this.prefs.paused = true; await this.persist(); this.status = this.busy ? "Pausing after the current upload finishes." : "Sync is paused."; return; }
      if (this.busy) throw new Error("Wait for the current sync to finish.");
      if (name === "resume") {
        if (!this.prefs.consent || (!this.prefs.agents.length && !this.prefs.bridge) || !(await loadConfig()).deviceId) throw new Error("Connect your account and approve sources first.");
        this.prefs.paused = false; this.nextSync = 0; await this.persist(); this.status = "Automatic sync resumed.";
      } else if (name === "save") {
        const server = serverOrigin(value.server), agents = sourceSelection(value.agents);
        if (((await loadConfig()).deviceId || this.pending) && server !== this.prefs.server) throw new Error("Disconnect before changing websites.");
        if (["bridge", "all", "consent"].some(k => typeof value[k] !== "boolean")) throw new Error("Invalid preferences.");
        if (value.consent && !agents.length && !value.bridge) throw new Error("Choose at least one source.");
        const changed = JSON.stringify(agents) !== JSON.stringify(this.prefs.agents) || value.all !== this.prefs.all || value.bridge !== this.prefs.bridge;
        if (changed) { const c = await loadConfig(); delete c.lastSyncAt; await saveConfig(c); }
        this.prefs = { ...this.prefs, server, agents, bridge: value.bridge, all: value.all, consent: value.consent, paused: !value.consent, imported: changed ? false : this.prefs.imported };
        await this.persist(); this.nextSync = 0; this.status = value.consent ? "Choices saved. Waiting for the first sync." : "Choices saved. Sync remains paused.";
      } else if (name === "pair") {
        if ((await loadConfig()).deviceId || this.pending) throw new Error("Already connected or waiting for approval.");
        const keys = generateDeviceKeyPair();
        try {
          await saveKey(`connect-pending-${keys.publicKey}`, keys.privateKeyPem);
          const p = await this.api({ action: "start", publicKey: keys.publicKey, label: `${hostname().slice(0, 48)} · Connect` });
          if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(p.code) || !/^[A-Za-z0-9_-]{43}$/.test(p.token) || !Number.isFinite(Date.parse(p.expiresAt))) throw new Error("Invalid pairing response.");
          this.pending = { code: p.code, token: p.token, expiresAt: p.expiresAt, server: this.prefs.server, publicKey: keys.publicKey };
          await saveKey(this.account, JSON.stringify(this.pending)); this.status = "Approve the matching code on the website. No data is syncing yet.";
        } catch (e) { await this.clearPending(); await deleteKey(`connect-pending-${keys.publicKey}`); throw e; }
      } else if (name === "cancel") {
        if (!this.pending) return;
        const p = await this.api({ action: "cancel", token: this.pending.token }, this.pending.server);
        if (!p.cancelled) throw new Error("Already approved. Wait for connection to finish, then disconnect.");
        await this.clearPending(); this.status = "Pairing cancelled.";
      } else if (name === "disconnect") {
        if (this.pending) throw new Error("Cancel pairing first.");
        this.prefs.paused = true; this.prefs.consent = false; this.prefs.imported = false; delete this.prefs.lastUpload; await this.persist();
        const c = await loadConfig();
        if (c.deviceId) {
          const exists = await loadKey(c.deviceId).then(() => true, () => false);
          if (exists && !await deleteKey(c.deviceId)) throw new Error("Could not remove device key. Revoke this device in website Settings.");
        }
        await saveConfig({ apiUrl: this.prefs.server, seq: 1 }); this.status = "Disconnected. Previously uploaded data remains. Revoke the old device in website Settings.";
      } else if (name === "sync") {
        if (!this.prefs.consent || this.prefs.paused) throw new Error("Approve your source choices before syncing.");
        if (!(await loadConfig()).deviceId) throw new Error("Connect your account first.");
        this.startSync();
      } else throw new Error("Unknown operation.");
    } finally { this.locked = false; }
  }
  async tick() {
    if (this.stopped || this.locked || this.busy) return;
    this.locked = true;
    try {
      if (this.pending) {
        if (Date.parse(this.pending.expiresAt) <= Date.now()) { await this.clearPending(); this.status = "Pairing expired. Connect again."; return; }
        const p = await this.api({ action: "poll", token: this.pending.token }, this.pending.server);
        if (p.status === "approved") {
          if (!/^dev_[A-Z0-9]+$/.test(p.deviceId) || typeof p.handle !== "string") throw new Error("Invalid approval response.");
          await saveKey(p.deviceId, (await loadKey(`connect-pending-${this.pending.publicKey}`)).privateKeyPem);
          await saveConfig({ apiUrl: this.pending.server, deviceId: p.deviceId, handle: p.handle, seq: 1 });
          await this.clearPending(); this.status = "Device registered. Approve your sources to start syncing.";
        } else if (["denied", "expired"].includes(p.status)) { await this.clearPending(); this.status = "Pairing declined or expired."; }
      }
      if (!this.pending && this.prefs.consent && !this.prefs.paused && Date.now() >= this.nextSync && (await loadConfig()).deviceId) this.startSync();
    } catch { this.status = "Cannot finish pairing yet. Retrying automatically."; }
    finally { this.locked = false; }
  }
  private startSync() {
    if (this.stopped) return;
    void this.runSync().catch(() => { this.prefs.paused = true; this.status = "Cannot save local sync state. Sync paused; check disk space and folder permissions."; });
  }
  private execute(options: { agents: string[]; bridge: boolean; all: boolean }): Promise<SyncResult> {
    if (this.runner) return this.runner(options);
    return new Promise(resolve => {
      const child = this.child = fork(join(__dirname, "worker.cjs"), [], { env: { ...cleanEnvironment(), USURP_CONFIG_DIR: join(this.directory, "device") }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let finished = false;
      const finish = (result: SyncResult) => { if (finished) return; finished = true; clearTimeout(timeout); child.kill(); this.child = undefined; resolve(result); };
      const timeout = setTimeout(() => finish({ ok: false, uploaded: false, warnings: 0 }), 15 * 60_000);
      child.on("error", () => finish({ ok: false, uploaded: false, warnings: 0 }));
      child.on("exit", () => finish({ ok: false, uploaded: false, warnings: 0 }));
      child.on("message", (m: any) => finish(m)); child.send(options);
    });
  }
  async runSync() {
    if (this.stopped || this.busy || this.prefs.paused || !this.prefs.consent || (!this.prefs.agents.length && !this.prefs.bridge)) return;
    this.busy = true; this.status = "Reading selected sources and uploading…"; this.warning = "";
    const all = this.prefs.all && !this.prefs.imported;
    try {
      const result = await this.execute({ agents: [...this.prefs.agents], bridge: this.prefs.bridge, all });
      this.prefs.lastAttempt = new Date().toISOString();
      if (!result.ok) throw new Error();
      this.failures = 0;
      if (all) this.prefs.imported = true;
      if (result.uploaded) this.prefs.lastUpload = this.prefs.lastAttempt;
      this.status = result.uploaded ? "Upload confirmed by Usurp. Your usage is available on the website." : "No records found in the selected window. Nothing was uploaded. Try older history or check your selected tools.";
      this.warning = result.warnings ? "Some records have reader or pricing warnings. See data coverage on your dashboard." : "";
    } catch {
      this.failures++; this.status = "Sync incomplete. Retrying automatically.";
      this.warning = "Check internet access, selected source permissions, AgentsView if enabled, and device revocation in website Settings. Some batches may already have arrived; retrying is safe.";
    } finally {
      this.nextSync = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** this.failures);
      try { await this.persist(); } finally { this.busy = false; }
      if (this.prefs.paused) this.status = "Sync is paused.";
    }
  }
  shutdown() { this.stopped = true; this.child?.kill(); }
}
