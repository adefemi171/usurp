/**
 * `~/.usurp/config.json` — everything about this device except the key.
 *
 * Explicitly *not* in here: the private key. That lives in the OS keychain (see
 * `keystore.ts`). A config file that is safe to read, copy, back up, and paste
 * into a bug report is worth more than one field's convenience.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  /** Where `usurp sync` submits. */
  apiUrl: string;
  deviceId?: string;
  handle?: string;
  /**
   * Next `seq` to use. `#3.4`'s monotonic per-device counter.
   *
   * Kept here rather than derived from a timestamp so that two syncs in the
   * same second cannot collide. If it drifts from the server's value, the
   * server's `stale_seq` response carries `last_seq` and `sync` re-anchors.
   */
  seq: number;
  /** ISO timestamp of the last successful sync, for the default lookback. */
  lastSyncAt?: string;
  agentsviewUrl?: string;
}

export const DEFAULT_API_URL = "http://localhost:3000";

export const DEFAULTS: Config = {
  apiUrl: process.env.USURP_API_URL ?? DEFAULT_API_URL,
  seq: 1,
};

export function configDir(): string {
  return process.env.USURP_CONFIG_DIR ?? join(homedir(), ".usurp");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      ...DEFAULTS,
      ...parsed,
      // A corrupt or hand-edited counter must not become NaN and poison every
      // subsequent payload; the server would reject it as a schema failure.
      seq:
        typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq) && parsed.seq >= 1
          ? parsed.seq
          : DEFAULTS.seq,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `writeFile`'s mode is ignored when the file already exists, so set it
  // explicitly rather than assuming a fresh create.
  await chmod(path, 0o600).catch(() => {});
}

/** Merge and persist in one step. */
export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await loadConfig()), ...patch };
  await saveConfig(next);
  return next;
}
