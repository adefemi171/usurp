/**
 * Device private key storage.
 *
 * Resolution order, highest priority first:
 *
 *   1. `USURP_DEVICE_KEY`   PKCS#8 PEM in the environment. Containers and CI.
 *   2. OS keychain          macOS Keychain / Windows Credential Manager /
 *                           Linux Secret Service, via `@napi-rs/keyring`.
 *   3. error                "run `usurp login`"
 *
 * The env var wins because a container has no keychain, and a machine that has
 * both is one where an operator deliberately injected a key and should not have
 * it silently ignored.
 *
 * The key is never written to `config.json`, never logged, and never included
 * in an error message. `@napi-rs/keyring` is an *optional* dependency: a
 * headless Linux box with no Secret Service still installs and still works via
 * the env var, which is exactly the Docker path.
 */

import type { PrivateKeyPem } from "@usurp/protocol";

const SERVICE = "usurp";
const ENV_VAR = "USURP_DEVICE_KEY";

export type KeySource = "env" | "keychain";

export class KeystoreError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "KeystoreError";
  }
}

interface KeyringEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

let keyringModule: KeyringModule | null | undefined;

/**
 * Held in a variable rather than written as a literal in the `import()` below.
 *
 * `@napi-rs/keyring` is an optional dependency, so a build that installs with
 * `--omit=optional` — the Docker image does, since nothing there runs the CLI
 * and musl has no prebuild — has no such module on disk. A literal specifier
 * makes `tsc` resolve it at compile time and fail the whole build. Going
 * through a variable keeps the dependency genuinely optional at both compile
 * and run time; `KeyringModule` above is the contract we rely on.
 */
const KEYRING_MODULE = "@napi-rs/keyring";

/**
 * Load the native keyring lazily.
 *
 * `undefined` means "not tried yet", `null` means "unavailable here". Resolving
 * once and caching the negative matters: on a headless box the import throws,
 * and retrying per call would pay that cost on every sync.
 */
async function keyring(): Promise<KeyringModule | null> {
  if (keyringModule !== undefined) return keyringModule;
  try {
    keyringModule = (await import(KEYRING_MODULE)) as KeyringModule;
  } catch {
    keyringModule = null;
  }
  return keyringModule;
}

export async function keychainAvailable(): Promise<boolean> {
  return (await keyring()) !== null;
}

function fromEnv(): PrivateKeyPem | undefined {
  const raw = process.env[ENV_VAR];
  if (!raw || raw.trim().length === 0) return undefined;
  // Compose and CI often carry the PEM with literal `\n` escapes rather than
  // real newlines; PKCS#8 parsing needs the real thing.
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

export interface ResolvedKey {
  privateKeyPem: PrivateKeyPem;
  source: KeySource;
}

/** Find the device key, or throw a `KeystoreError` explaining what to do. */
export async function loadKey(deviceId: string): Promise<ResolvedKey> {
  const fromEnvironment = fromEnv();
  if (fromEnvironment) {
    return { privateKeyPem: fromEnvironment, source: "env" };
  }

  const mod = await keyring();
  if (!mod) {
    throw new KeystoreError(
      "no device key available and no OS keychain on this system",
      `Set ${ENV_VAR} to the device's PKCS#8 PEM, or run \`usurp login\` on a desktop machine.`,
    );
  }

  try {
    const password = new mod.Entry(SERVICE, deviceId).getPassword();
    if (!password) throw new Error("empty");
    return { privateKeyPem: password, source: "keychain" };
  } catch {
    throw new KeystoreError(
      `no key in the keychain for device ${deviceId}`,
      "Run `usurp login <code>` to enrol this machine.",
    );
  }
}

/** Store a freshly generated key. Throws if there is nowhere safe to put it. */
export async function saveKey(
  deviceId: string,
  privateKeyPem: PrivateKeyPem,
): Promise<KeySource> {
  const mod = await keyring();
  if (!mod) {
    // Deliberately *not* falling back to a plaintext file. The user chose
    // keychain storage; silently downgrading to disk would put key material
    // somewhere they did not agree to, and the env var is the supported
    // headless path.
    throw new KeystoreError(
      "no OS keychain available, so there is nowhere safe to store the key",
      `On a headless host or in a container, generate the key elsewhere and pass it via ${ENV_VAR}.`,
    );
  }

  try {
    new mod.Entry(SERVICE, deviceId).setPassword(privateKeyPem);
    return "keychain";
  } catch (err) {
    throw new KeystoreError(
      "the OS keychain refused to store the device key",
      err instanceof Error ? err.message : undefined,
    );
  }
}

/** Remove a device key. Returns false when there was nothing to remove. */
export async function deleteKey(deviceId: string): Promise<boolean> {
  const mod = await keyring();
  if (!mod) return false;
  try {
    return new mod.Entry(SERVICE, deviceId).deletePassword();
  } catch {
    return false;
  }
}

/** Where a key would come from right now, without loading it. */
export async function describeSource(deviceId: string): Promise<KeySource | "none"> {
  if (fromEnv()) return "env";
  const mod = await keyring();
  if (!mod) return "none";
  try {
    return new mod.Entry(SERVICE, deviceId).getPassword() ? "keychain" : "none";
  } catch {
    return "none";
  }
}
