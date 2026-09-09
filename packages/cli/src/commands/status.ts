/**
 * `usurp status` — is this machine wired up correctly?
 *
 * Checks the three things that independently break: the config, the key, and
 * the server. Reporting them separately matters because the fixes differ —
 * a missing key means re-login, an unreachable server means check the URL.
 */

import { publicKeyFromPem } from "@usurp/protocol";
import { ApiClient } from "../api.js";
import { configPath, loadConfig } from "../config.js";
import { describeSource, keychainAvailable, loadKey } from "../keystore.js";
import { bold, cyan, dim, green, info, red, yellow } from "../ui.js";

const ok = () => green("ok");
const missing = () => yellow("missing");
const bad = () => red("error");

export async function status(): Promise<number> {
  const config = await loadConfig();
  let healthy = true;

  info("");
  info(bold("device"));
  info(`  config     ${dim(configPath())}`);
  info(`  api        ${config.apiUrl}`);

  if (!config.deviceId) {
    info(`  device_id  ${missing()}  ${dim("run `usurp login <code>`")}`);
    healthy = false;
  } else {
    info(`  device_id  ${cyan(config.deviceId)}`);
    info(`  next seq   ${config.seq}`);
    info(`  last sync  ${config.lastSyncAt ?? dim("never")}`);
  }

  info("");
  info(bold("key"));
  info(`  keychain   ${(await keychainAvailable()) ? ok() : dim("unavailable on this system")}`);

  if (config.deviceId) {
    const source = await describeSource(config.deviceId);
    if (source === "none") {
      info(`  key        ${missing()}  ${dim("run `usurp login <code>`")}`);
      healthy = false;
    } else {
      info(`  key        ${ok()}  ${dim(`from ${source === "env" ? "USURP_DEVICE_KEY" : "OS keychain"}`)}`);
      try {
        // Derives the public key without the private half leaving the keystore
        // module, so a mismatched or corrupt entry is caught here rather than
        // as a confusing 401 mid-sync.
        const { privateKeyPem } = await loadKey(config.deviceId);
        info(`  pubkey     ${dim(publicKeyFromPem(privateKeyPem))}`);
      } catch (err) {
        info(`  pubkey     ${bad()}  ${dim(err instanceof Error ? err.message : "unreadable")}`);
        healthy = false;
      }
    }
  }

  info("");
  info(bold("server"));
  const reachable = await new ApiClient(config.apiUrl).health();
  info(`  health     ${reachable ? ok() : bad()}  ${dim(config.apiUrl)}`);
  if (!reachable) healthy = false;

  info("");
  return healthy ? 0 : 1;
}
