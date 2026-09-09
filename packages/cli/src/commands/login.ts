/**
 * `usurp login <code>` — enrol this machine.
 *
 * Generates a keypair, sends the *public* half with the enrollment code, and
 * puts the private half in the OS keychain. The private key does not touch
 * disk, is not returned by any function that logs, and cannot be recovered
 * from the server.
 */

import { hostname } from "node:os";
import { generateDeviceKeyPair } from "@usurp/protocol";
import { ApiClient } from "../api.js";
import { loadConfig, saveConfig } from "../config.js";
import { deleteKey, KeystoreError, saveKey } from "../keystore.js";
import { bold, cyan, dim, error, info, reserveStdoutForData, success, warn } from "../ui.js";

export interface LoginOptions {
  code?: string;
  api?: string;
  label?: string;
  /**
   * Print the private key to stdout instead of storing it in the keychain.
   *
   * The escape hatch for headless Linux, containers, and CI, where there is no
   * Secret Service to talk to. Without it those platforms could enrol but never
   * store a key, because `saveKey` refuses to silently fall back to a plaintext
   * file. Opt-in only, and it says plainly what it just put on your terminal.
   */
  printKey?: boolean;
}

export async function login(options: LoginOptions): Promise<number> {
  if (!options.code) {
    error("missing enrollment code", "usurp login <code> [--api <url>]");
    return 2;
  }

  // With --print-key, stdout carries the PEM and nothing else, so that
  // `usurp login ... --print-key > device.key` yields a usable key file.
  if (options.printKey) reserveStdoutForData();

  const config = await loadConfig();
  const apiUrl = options.api ?? config.apiUrl;
  const client = new ApiClient(apiUrl);
  const label = options.label ?? hostname();

  // Generated locally. The server never sees, and cannot ask for, the private
  // half — which is why `cli_signed` proves provenance and not truthfulness.
  const { publicKey, privateKeyPem } = generateDeviceKeyPair();

  const result = await client.registerDevice({ code: options.code, publicKey, label });

  if (!result.ok) {
    if (result.status === 0) {
      error(`cannot reach ${apiUrl}`, result.detail);
      return 1;
    }
    if (result.status === 401) {
      error(
        "that enrollment code is not valid",
        "Codes expire after 15 minutes and work once. Ask for a fresh one.",
      );
      return 1;
    }
    error(`registration failed (${result.status}): ${result.error}`, result.detail);
    return 1;
  }

  const { device_id: deviceId, trust_tier: trustTier, reused } = result.data;

  let stored: "keychain" | "stdout";
  if (options.printKey) {
    stored = "stdout";
  } else {
    try {
      await saveKey(deviceId, privateKeyPem);
      stored = "keychain";
    } catch (err) {
      if (err instanceof KeystoreError) {
        error(err.message, "Re-run with --print-key to receive the key on stdout instead.");
        return 1;
      }
      throw err;
    }
  }

  /**
   * A re-registered key keeps its `seq` on the server, so a config that starts
   * back at 1 would be refused until it caught up. Sync re-anchors from the
   * server's `last_seq`, but starting from a sane value avoids a wasted round
   * trip on the very first sync after a re-login.
   */
  await saveConfig({
    ...config,
    apiUrl,
    deviceId,
    seq: reused ? config.seq : 1,
    ...(reused ? {} : { lastSyncAt: undefined }),
  });

  if (reused) {
    warn(`this key was already enrolled as ${bold(deviceId)}`);
    info(dim("  The enrollment code was not consumed."));
  } else {
    success(`enrolled as ${bold(deviceId)}  ${dim(`(${trustTier})`)}`);
  }

  info("");
  info(`  ${dim("api")}     ${apiUrl}`);
  info(
    stored === "keychain"
      ? `  ${dim("key")}     OS keychain, service ${cyan("usurp")}, account ${cyan(deviceId)}`
      : `  ${dim("key")}     printed below — not stored anywhere by this command`,
  );
  info(`  ${dim("pubkey")}  ${publicKey}`);
  info("");

  if (stored === "stdout") {
    warn("The private key is printed below. It is not saved anywhere.");
    info(dim("  Put it in your secret manager or CI secret store, then expose it as"));
    info(dim(`  ${bold("USURP_DEVICE_KEY")}. It cannot be recovered — losing it means re-enrolling.`));
    info("");
    // stdout, not the log helpers, so `... --print-key | grep -v` style
    // piping works and the key is not decorated with escape codes.
    process.stdout.write(`${privateKeyPem}\n`);
    return 0;
  }

  info(`Next: ${cyan("usurp preview")} to see exactly what would be sent, then ${cyan("usurp sync")}.`);

  return 0;
}

/** `usurp logout` — forget the device and drop its key from the keychain. */
export async function logout(): Promise<number> {
  const config = await loadConfig();
  if (!config.deviceId) {
    warn("not logged in");
    return 0;
  }

  const removed = await deleteKey(config.deviceId);
  await saveConfig({
    apiUrl: config.apiUrl,
    seq: 1,
  });

  // The server-side device row is left intact on purpose: its history and its
  // `last_seq` are what stop a discarded key's captured payloads from being
  // replayed later. Revocation is a separate, deliberate act.
  success(
    removed
      ? `removed the key for ${config.deviceId} from the keychain`
      : `cleared local config for ${config.deviceId} (no key was in the keychain)`,
  );
  info(dim("  The device is still registered server-side. Revoke it there to disable it."));
  return 0;
}
