import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  generateDeviceKeyPair,
  importPublicKey,
  KeyFormatError,
  publicKeyFromPem,
  signBytes,
  verifyBytes,
  PUBLIC_KEY_BYTES,
} from "./keys.js";

const message = Buffer.from("the throne must be actively held", "utf8");

describe("device keys", () => {
  it("generates a raw base64url public key and a PKCS#8 PEM private key", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();

    expect(Buffer.from(publicKey, "base64url")).toHaveLength(PUBLIC_KEY_BYTES);
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);

    // The private half stays in a standard container — never raw bytes in a
    // string, which is what would end up in config.json or a backup.
    expect(privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(privateKeyPem).toMatch(/-----END PRIVATE KEY-----\n?$/);
  });

  it("generates a distinct key each time", () => {
    expect(generateDeviceKeyPair().publicKey).not.toBe(generateDeviceKeyPair().publicKey);
  });

  it("round-trips sign and verify", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    expect(verifyBytes(message, signBytes(message, privateKeyPem), publicKey)).toBe(true);
  });

  it("derives the matching public key from a stored PEM", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    // `usurp status` uses this to confirm the keychain entry still matches the
    // device_id the server has on file.
    expect(publicKeyFromPem(privateKeyPem)).toBe(publicKey);
  });

  it("rejects a signature from a different device", () => {
    const alice = generateDeviceKeyPair();
    const mallory = generateDeviceKeyPair();
    const sig = signBytes(message, mallory.privateKeyPem);
    expect(verifyBytes(message, sig, alice.publicKey)).toBe(false);
  });

  it("rejects a tampered message", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const sig = signBytes(message, privateKeyPem);
    expect(verifyBytes(Buffer.from("tampered", "utf8"), sig, publicKey)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const sig = Buffer.from(signBytes(message, privateKeyPem), "base64url");
    sig[0] ^= 0xff;
    expect(verifyBytes(message, sig.toString("base64url"), publicKey)).toBe(false);
  });

  describe("verifyBytes fails closed rather than throwing", () => {
    // A request handler treats verification as one boolean gate, so no
    // malformed input from the wire may become a 500.
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const sig = signBytes(message, privateKeyPem);

    const cases: Array<[string, string, string]> = [
      ["empty signature", "", publicKey],
      ["non-base64url signature", "not*valid*b64", publicKey],
      ["truncated signature", sig.slice(0, 40), publicKey],
      ["empty public key", sig, ""],
      ["non-base64url public key", sig, "not*valid*b64"],
      ["wrong-length public key", sig, Buffer.alloc(16).toString("base64url")],
    ];

    for (const [name, signature, key] of cases) {
      it(name, () => {
        expect(verifyBytes(message, signature, key)).toBe(false);
      });
    }
  });

  it("throws a typed error for a malformed public key on explicit import", () => {
    expect(() => importPublicKey("")).toThrow(KeyFormatError);
    expect(() => importPublicKey("!!!")).toThrow(KeyFormatError);
    expect(() => importPublicKey(Buffer.alloc(31).toString("base64url"))).toThrow(
      /must decode to 32 bytes, got 31/,
    );
  });

  it("does not echo key material in error messages", () => {
    // A stack trace containing a private key is the leak this module exists to
    // avoid, so failures must describe the problem without quoting the input.
    const secret = "-----BEGIN PRIVATE KEY-----\nZm9vYmFy\n-----END PRIVATE KEY-----";
    try {
      signBytes(message, secret);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(KeyFormatError);
      expect((err as Error).message).not.toContain("Zm9vYmFy");
      expect((err as Error).message).toContain("PKCS#8");
    }
  });

  it("rejects a well-formed key on the wrong curve", () => {
    // An RSA or P-256 key is a readable PKCS#8 PEM but cannot produce an
    // ed25519 signature; the error should say which curve was found.
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => signBytes(message, pem)).toThrow(/must be ed25519, got ec/);
  });
});
