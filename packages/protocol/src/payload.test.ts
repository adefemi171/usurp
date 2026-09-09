import { describe, expect, it } from "vitest";
import { generateDeviceKeyPair } from "./keys.js";
import {
  bucketSchema,
  dedupeKey,
  envelopeSchema,
  PAYLOAD_VERSION,
  payloadSchema,
  signPayload,
  verifyPayload,
  type Bucket,
  type Envelope,
} from "./payload.js";

const DEVICE = "dev_01HQ8Z";

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  const base = {
    hour: "2026-09-08T13:00:00Z",
    agent: "claude-code",
    model: "claude-opus-5",
    input_tokens: 12043,
    output_tokens: 3311,
    cache_write_tokens: 8100,
    cache_read_tokens: 96500,
    calls: 14,
    sessions_started: 2,
    sessions_completed: 1,
    sessions_abandoned: 1,
    edits_applied: 9,
    edits_reverted: 1,
    commits: 2,
    cost_micros: 41200,
    ...overrides,
  };
  return {
    ...base,
    dedupe_key: overrides.dedupe_key ?? dedupeKey(DEVICE, base.hour, base.agent, base.model),
  };
}

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: PAYLOAD_VERSION,
    device_id: DEVICE,
    seq: 1,
    submitted_at: "2026-09-08T13:59:00.000Z",
    buckets: [bucket()],
    ...overrides,
  };
}

describe("dedupeKey", () => {
  it("is sha256 hex of device_id|hour|agent|model", () => {
    const key = dedupeKey(DEVICE, "2026-09-08T13:00:00Z", "claude-code", "claude-opus-5");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    const args = [DEVICE, "2026-09-08T13:00:00Z", "claude-code", "claude-opus-5"] as const;
    expect(dedupeKey(...args)).toBe(dedupeKey(...args));
  });

  it("changes with every component", () => {
    const base = dedupeKey(DEVICE, "2026-09-08T13:00:00Z", "claude-code", "claude-opus-5");
    expect(dedupeKey("dev_other", "2026-09-08T13:00:00Z", "claude-code", "claude-opus-5")).not.toBe(base);
    expect(dedupeKey(DEVICE, "2026-09-08T14:00:00Z", "claude-code", "claude-opus-5")).not.toBe(base);
    expect(dedupeKey(DEVICE, "2026-09-08T13:00:00Z", "codex", "claude-opus-5")).not.toBe(base);
    expect(dedupeKey(DEVICE, "2026-09-08T13:00:00Z", "claude-code", "claude-sonnet-5")).not.toBe(base);
  });
});

describe("signPayload / verifyPayload", () => {
  it("round-trips", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const payload = signPayload(envelope(), privateKeyPem);
    expect(verifyPayload(payload, publicKey)).toBe(true);
  });

  it("produces a payload that satisfies the wire schema", () => {
    const { privateKeyPem } = generateDeviceKeyPair();
    expect(() => payloadSchema.parse(signPayload(envelope(), privateKeyPem))).not.toThrow();
  });

  it("verifies regardless of key insertion order", () => {
    // The reason canonical JSON exists: a payload that round-trips through a
    // proxy or a different JSON library must still verify.
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const payload = signPayload(envelope(), privateKeyPem);

    const reordered = JSON.parse(
      JSON.stringify({
        buckets: payload.buckets.map((b) =>
          Object.fromEntries(Object.entries(b).reverse()),
        ),
        submitted_at: payload.submitted_at,
        seq: payload.seq,
        device_id: payload.device_id,
        v: payload.v,
        sig: payload.sig,
      }),
    );

    expect(verifyPayload(reordered, publicKey)).toBe(true);
  });

  it("rejects a signature from another device", () => {
    const alice = generateDeviceKeyPair();
    const mallory = generateDeviceKeyPair();
    const payload = signPayload(envelope(), mallory.privateKeyPem);
    expect(verifyPayload(payload, alice.publicKey)).toBe(false);
  });

  // The signature covers the whole envelope, not just `buckets`. Each of these
  // is a field an attacker would want to change on a captured payload; every
  // one must break the signature rather than relying on the UNIQUE dedupe_key
  // constraint to absorb it.
  describe("the envelope is tamper-evident", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const signed = signPayload(envelope(), privateKeyPem);

    it("detects a replayed batch renumbered to a fresh seq", () => {
      expect(verifyPayload({ ...signed, seq: 999 }, publicKey)).toBe(false);
    });

    it("detects a replayed batch restamped with a current time", () => {
      expect(
        verifyPayload({ ...signed, submitted_at: "2026-09-09T13:59:00.000Z" }, publicKey),
      ).toBe(false);
    });

    it("detects a batch re-attributed to another device", () => {
      expect(verifyPayload({ ...signed, device_id: "dev_victim" }, publicKey)).toBe(false);
    });

    it("detects an inflated token count", () => {
      const buckets = [{ ...signed.buckets[0]!, output_tokens: 999_999 }];
      expect(verifyPayload({ ...signed, buckets }, publicKey)).toBe(false);
    });

    it("detects an appended bucket", () => {
      const buckets = [...signed.buckets, bucket({ hour: "2026-09-08T14:00:00Z" })];
      expect(verifyPayload({ ...signed, buckets }, publicKey)).toBe(false);
    });

    it("detects a removed bucket", () => {
      const two = signPayload(
        envelope({ buckets: [bucket(), bucket({ hour: "2026-09-08T14:00:00Z" })] }),
        privateKeyPem,
      );
      expect(verifyPayload({ ...two, buckets: [two.buckets[0]!] }, publicKey)).toBe(false);
    });

    it("detects a bumped payload version", () => {
      expect(verifyPayload({ ...signed, v: 2 as 1 }, publicKey)).toBe(false);
    });
  });

  it("fails closed on a payload that cannot be canonicalized", () => {
    const { publicKey, privateKeyPem } = generateDeviceKeyPair();
    const signed = signPayload(envelope(), privateKeyPem);
    // A float injected post-signing must not throw out of the handler.
    const buckets = [{ ...signed.buckets[0]!, cost_micros: 1.5 }];
    expect(verifyPayload({ ...signed, buckets }, publicKey)).toBe(false);
  });
});

describe("schemas", () => {
  it("accepts a well-formed bucket", () => {
    expect(() => bucketSchema.parse(bucket())).not.toThrow();
  });

  it("rejects an hour that is not a UTC hour boundary", () => {
    expect(() => bucketSchema.parse(bucket({ hour: "2026-09-08T13:30:00Z" }))).toThrow();
    expect(() => bucketSchema.parse(bucket({ hour: "2026-09-08T13:00:00+02:00" }))).toThrow();
    expect(() => bucketSchema.parse(bucket({ hour: "2026-09-08" }))).toThrow();
  });

  it("rejects an hour that parses to no real date", () => {
    expect(() => bucketSchema.parse(bucket({ hour: "2026-13-45T13:00:00Z" }))).toThrow();
  });

  it("rejects negative and fractional counters", () => {
    expect(() => bucketSchema.parse(bucket({ input_tokens: -1 }))).toThrow();
    expect(() => bucketSchema.parse(bucket({ cost_micros: 0.5 }))).toThrow();
  });

  it("rejects unknown fields, so a silently-added metric cannot slip through", () => {
    expect(() =>
      bucketSchema.parse({ ...bucket(), prompt: "leaked prompt text" }),
    ).toThrow();
  });

  it("rejects a malformed dedupe_key", () => {
    expect(() => bucketSchema.parse(bucket({ dedupe_key: "nope" }))).toThrow();
    expect(() => bucketSchema.parse(bucket({ dedupe_key: "A".repeat(64) }))).toThrow();
  });

  it("requires at least one bucket and caps batch size", () => {
    expect(() => envelopeSchema.parse(envelope({ buckets: [] }))).toThrow();
    const many = Array.from({ length: 2001 }, () => bucket());
    expect(() => envelopeSchema.parse(envelope({ buckets: many }))).toThrow();
  });

  it("requires seq to start at 1", () => {
    expect(() => envelopeSchema.parse(envelope({ seq: 0 }))).toThrow();
  });

  it("rejects an unknown payload version", () => {
    expect(() => envelopeSchema.parse(envelope({ v: 2 as 1 }))).toThrow();
  });
});
