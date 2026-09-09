import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const label = "com.usurp.connect-service";
const xml = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
export function startupFile() {
  return process.platform === "darwin" ? join(homedir(), "Library/LaunchAgents", `${label}.plist`) : join(homedir(), ".config/systemd/user/usurp-connect.service");
}
export async function startupStatus() {
  const supported = ["darwin", "linux"].includes(process.platform);
  return { supported, enabled: supported && await readFile(startupFile(), "utf8").then(s => s.includes("Usurp Connect managed login entry"), () => false) };
}
export async function setStartup(enabled: boolean, data: string, entry: string, port: number) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Automatic login startup is currently supported on macOS and Linux. Run usurp-connect after signing in on Windows.");
  const path = startupFile();
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing && !existing.includes("Usurp Connect managed login entry")) throw new Error("An unmanaged startup file already exists. It has not been changed.");
  const args = [process.execPath, entry, "start", "--no-open", "--data-dir", data, "--port", String(port)];
  if (!enabled) {
    if (!existing) return;
    if (process.platform === "darwin") await exec("launchctl", ["bootout", `gui/${process.getuid!()}`, path]).catch(() => {});
    else await exec("systemctl", ["--user", "disable", "usurp-connect.service"]);
    await unlink(path);
    if (process.platform === "linux") await exec("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  const contents = process.platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><!-- Usurp Connect managed login entry --><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/></dict></plist>`
    : `# Usurp Connect managed login entry\n[Unit]\nDescription=Usurp Connect\n[Service]\nType=oneshot\nExecStart=${args.map(a => '"' + a.replace(/[%\\"\n\r]/g, c => c === "%" ? "%%" : c === "\n" || c === "\r" ? "" : `\\${c}`) + '"').join(" ")}\nRemainAfterExit=yes\n[Install]\nWantedBy=default.target\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
  try {
    if (process.platform === "darwin") {
      await exec("launchctl", ["bootout", `gui/${process.getuid!()}`, path]).catch(() => {});
      await exec("launchctl", ["bootstrap", `gui/${process.getuid!()}`, path]);
    } else { await exec("systemctl", ["--user", "daemon-reload"]); await exec("systemctl", ["--user", "enable", "usurp-connect.service"]); }
  } catch {
    if (existing) await writeFile(path, existing, { mode: 0o600 }); else await unlink(path);
    throw new Error("Could not enable login startup. Your login service manager must be available. Manual background start still works.");
  }
}
