/**
 * ed25519 device keys.
 *
 * Two asymmetric formats, deliberately different, so the type system reflects
 * the sensitivity of each half:
 *
 *   PublicKeyB64   raw 32-byte public key, base64url. Public. Travels on the
 *                  wire, lives in `devices.public_key`, safe to log or paste
 *                  into a URL. Short enough to keep the column narrow.
 *
 *   PrivateKeyPem  PKCS#8 PEM. SECRET. Produced once by `generateDeviceKeyPair`
 *                  and handed straight to the OS keychain. Never logged, never
 *                  transmitted, never written to `config.json`.
 *
 * The private half is PKCS#8 rather than a raw 32-byte seed on purpose. Raw
 * seed bytes as a JSON string are what secret scanners flag and what leaks via
 * backups and dotfile sync, and handling them means hand-rolling raw<->JWK
 * conversion. PKCS#8 is what `node:crypto` reads and writes natively, so this
 * module contains no bespoke key encoding at all.
 *
 * Nothing here ever converts a private key to raw bytes. If you find yourself
 * adding that, put the key in the keychain instead.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";

export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

/** Raw 32-byte ed25519 public key, base64url. Not sensitive. */
export type PublicKeyB64 = string;

/**
 * PKCS#8 PEM private key. SENSITIVE — do not log, serialize into config, or
 * include in error messages.
 */
export type PrivateKeyPem = string;

export class KeyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyFormatError";
  }
}

function decodeB64Url(value: string, expectedBytes: number, label: string): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new KeyFormatError(`${label} must be a non-empty base64url string`);
  }
  // Node's base64url decoder is lenient — it drops unrecognized characters
  // rather than throwing — so a mangled value would otherwise surface as a
  // silent verification failure instead of a clear error.
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
    throw new KeyFormatError(`${label} is not valid base64url`);
  }
  const buf = Buffer.from(value, "base64url");
  if (buf.length !== expectedBytes) {
    throw new KeyFormatError(
      `${label} must decode to ${expectedBytes} bytes, got ${buf.length}`,
    );
  }
  return buf;
}

export interface DeviceKeyPair {
  /** Send this to the server. */
  publicKey: PublicKeyB64;
  /** Put this in the keychain. Never anywhere else. */
  privateKeyPem: PrivateKeyPem;
}

/**
 * Generate a device keypair. Called exactly once per device, by `usurp login`.
 *
 * The caller is responsible for persisting `privateKeyPem` to the keychain and
 * dropping its reference promptly; the value should not be passed around or
 * held in long-lived state.
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: rawPublicKey(publicKey),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** Extract the raw base64url public key from a KeyObject of either half. */
function rawPublicKey(key: KeyObject): PublicKeyB64 {
  const source = key.type === "private" ? createPublicKey(key) : key;
  const jwk = source.export({ format: "jwk" }) as { crv?: string; x?: string };
  if (jwk.crv !== "Ed25519" || !jwk.x) {
    throw new KeyFormatError("key is not an ed25519 key");
  }
  return jwk.x;
}

/**
 * Derive the public key from a stored PEM — used by `usurp status` to confirm
 * the keychain entry still matches the `device_id` the server knows, without
 * the private key leaving this module.
 */
export function publicKeyFromPem(privateKeyPem: PrivateKeyPem): PublicKeyB64 {
  return rawPublicKey(loadPrivateKey(privateKeyPem));
}

/** Rehydrate a public key for verification. Throws `KeyFormatError` if malformed. */
export function importPublicKey(publicKey: PublicKeyB64): KeyObject {
  // Validate length before handing to createPublicKey so the error names the
  // problem rather than surfacing an opaque OpenSSL failure.
  decodeB64Url(publicKey, PUBLIC_KEY_BYTES, "public key");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: publicKey },
    format: "jwk",
  });
}

/**
 * Parse a PKCS#8 PEM into a signing key.
 *
 * Errors are phrased without echoing the input: a stack trace containing a
 * private key is exactly the leak this module exists to avoid.
 */
function loadPrivateKey(privateKeyPem: PrivateKeyPem): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new KeyFormatError("device key is not a readable PKCS#8 PEM");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new KeyFormatError(
      `device key must be ed25519, got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }
  return key;
}

/** Sign `message` with the device key. Returns a base64url signature. */
export function signBytes(message: Buffer, privateKeyPem: PrivateKeyPem): string {
  return cryptoSign(null, message, loadPrivateKey(privateKeyPem)).toString("base64url");
}

/**
 * Verify a signature. Returns false — never throws — for every rejection
 * reason, including a malformed key or signature, so a request handler can
 * treat it as one boolean gate.
 */
export function verifyBytes(
  message: Buffer,
  signature: string,
  publicKey: PublicKeyB64,
): boolean {
  try {
    const sig = decodeB64Url(signature, SIGNATURE_BYTES, "signature");
    return cryptoVerify(null, message, importPublicKey(publicKey), sig);
  } catch {
    return false;
  }
}
