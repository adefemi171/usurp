#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFile, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Controller } from "./controller.js";
import { serve } from "./server.js";
import { cleanEnvironment, serverOrigin } from "./policy.js";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; if (!args[i+1] || args[i+1].startsWith("--")) throw new Error(`Missing value for ${name}`); return args[i+1]; };
type Runtime = { origin: string; token: string; pid: number };
async function runtime(directory: string): Promise<Runtime | undefined> {
  try {
    const r = JSON.parse(await readFile(join(directory, "runtime.json"), "utf8"));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(r.origin) || !/^[A-Za-z0-9_-]{43}$/.test(r.token)) return;
    const response = await fetch(`${r.origin}/api/state`, { headers: { authorization: `Bearer ${r.token}` }, signal: AbortSignal.timeout(1000), redirect: "error" });
    if (response.ok) return r;
  } catch { /* stopped or stale runtime marker */ }
}
function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.log("Could not open a browser automatically. Use the local URL printed above.")); child.unref();
}
async function main() {
  if (args.includes("--help") || args[0] === "help") {
    console.log("Usurp Connect\n\n  usurp-connect                 Start in background and open local controls\n  usurp-connect start --no-open  Start without opening a browser\n  usurp-connect status           Show connection and last upload\n  usurp-connect stop             Stop this background service\n  usurp-connect serve            Run in the foreground\n\nOptions: --server https://usurp.onrender.com --port 43127 --data-dir PATH\nEnable start at login, choose sources, pause, or disconnect in the local controls.\nNode.js 22.13+ required. Keys stay in the OS keychain. No sources enabled by default."); return;
  }
  const command = args[0] && !args[0].startsWith("--") ? args[0] : "start";
  if (!["start", "serve", "status", "stop"].includes(command)) throw new Error("Unknown command. Run usurp-connect --help.");
  const directory = resolve(option("--data-dir") ?? join(homedir(), ".usurp-connect"));
  const port = Number(option("--port") ?? 43127);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local port.");
  const proposedServer = option("--server"); if (proposedServer) serverOrigin(proposedServer);
  if (command === "serve") {
    for (const key of Object.keys(process.env)) if (key.startsWith("USURP_")) delete process.env[key];
    const existing = await runtime(directory); if (existing) throw new Error("Connect is already running for this data directory.");
    const controller = new Controller(directory); await controller.init();
    if (proposedServer) {
      const state = await controller.state();
      if ((state.deviceId || state.pairing) && controller.prefs.server !== serverOrigin(proposedServer)) throw new Error("Already paired to a different website. Disconnect in local controls before switching.");
      controller.prefs.server = serverOrigin(proposedServer); await controller.persist();
    }
    const service = await serve(controller, port);
    console.log(`Usurp Connect is listening on ${service.origin}. Run usurp-connect to open authenticated controls.`);
    process.once("SIGTERM", () => void service.close()); process.once("SIGINT", () => void service.close());
    return;
  }
  let r = await runtime(directory);
  if (command === "stop") {
    if (!r) { console.log("Usurp Connect is not running."); return; }
    await fetch(`${r.origin}/api/action`, { method: "POST", headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" }, body: JSON.stringify({ action: "stop" }), signal: AbortSignal.timeout(5000), redirect: "error" });
    console.log("Usurp Connect stopped. Start-at-login, if enabled, is unchanged."); return;
  }
  if (command === "status") {
    if (!r) { console.log("Usurp Connect is not running. Run usurp-connect to start it."); return; }
    const s = await (await fetch(`${r.origin}/api/state`, { headers: { authorization: `Bearer ${r.token}` }, signal: AbortSignal.timeout(5000), redirect: "error" })).json();
    console.log(JSON.stringify({ server: s.server, deviceId: s.deviceId, paused: s.paused, status: s.status, lastUpload: s.lastUpload ?? "never", lastAttempt: s.lastAttempt ?? "never", warning: s.warning }, null, 2)); return;
  }
  if (!r) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const log = await open(join(directory, "service.log"), "w", 0o600);
    const child = spawn(process.execPath, [join(__dirname, "main.cjs"), "serve", "--data-dir", directory, "--port", String(port), ...(proposedServer ? ["--server", proposedServer] : [])], { detached: true, stdio: ["ignore", log.fd, log.fd], env: cleanEnvironment() });
    let failed = false; child.on("error", () => { failed = true; }); child.unref(); await log.close();
    for (let i = 0; i < 60 && !failed; i++) { await delay(250); r = await runtime(directory); if (r) break; }
    if (!r) throw new Error(`Connect did not start. Check ${join(directory, "service.log")}. If port ${port} is occupied, use --port with an unused port.`);
  }
  if (proposedServer) {
    const s = await (await fetch(`${r.origin}/api/state`, { headers: { authorization: `Bearer ${r.token}` }, signal: AbortSignal.timeout(5000) })).json();
    if (s.server !== serverOrigin(proposedServer)) throw new Error("The running service uses a different website. Open its local controls to disconnect and switch websites.");
  }
  const url = `${r.origin}/#${r.token}`;
  if (!args.includes("--no-open")) { console.log(`Local controls (private to this computer; do not share): ${url}`); openBrowser(url); }
  else console.log(`Usurp Connect is running at ${r.origin}. Run usurp-connect to open its controls.`);
}
void main().catch(e => { console.error(e instanceof Error ? e.message : "Connect could not start."); process.exitCode = 1; });
