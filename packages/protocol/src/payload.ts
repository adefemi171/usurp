/**
 * The wire payload — `SPEC.md#3.3`, plus the replay hardening noted in the
 * spec review.
 *
 * The spec's draft signed `canonical_json(buckets)` alone. That leaves a
 * captured payload replayable verbatim, with the `UNIQUE dedupe_key` constraint
 * as the only thing absorbing it. Relying on a DB constraint for replay
 * protection is fragile: loosen the dedupe key, or add any metric that is not
 * hour-bucketed, and the protection silently disappears.
 *
 * So the signature covers the whole envelope — `device_id`, a monotonic `seq`,
 * `submitted_at`, and the buckets. Costs nothing, and moves replay protection
 * into the crypto where it belongs.
 */

import { z } from "zod";
import { canonicalBytes } from "./canonical.js";
import { signBytes, verifyBytes, type PrivateKeyPem, type PublicKeyB64 } from "./keys.js";
import { createHash } from "node:crypto";
import { bridgeSnapshotSchema } from "./bridge.js";

export const PAYLOAD_VERSION = 1;

/** Every counter is a non-negative integer; see `canonical.ts` on why no floats. */
const counter = z.number().int().min(0);

/** `2026-09-08T13:00:00Z` — a UTC hour, minutes and seconds always zero. */
export const hourSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/,
    "hour must be a UTC hour boundary, e.g. 2026-09-08T13:00:00Z",
  )
  .refine((v) => !Number.isNaN(Date.parse(v)), "hour is not a real timestamp");

export const bucketSchema = z
  .object({
    hour: hourSchema,
    agent: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
    /** Explicit archive import; permanently excluded from competitive scoring. */
    historical: z.literal(true).optional(),

    input_tokens: counter,
    output_tokens: counter,
    cache_write_tokens: counter,
    cache_read_tokens: counter,

    calls: counter,
    sessions_started: counter,
    sessions_completed: counter,
    sessions_abandoned: counter,

    edits_applied: counter,
    edits_reverted: counter,
    commits: counter,

    cost_micros: counter,

    /** `sha256(device_id|hour|agent|model)`. Recomputed and checked server-side. */
    dedupe_key: z.string().regex(/^[0-9a-f]{64}$/, "dedupe_key must be sha256 hex"),
  })
  .strict();

export type Bucket = z.infer<typeof bucketSchema>;

/** The signed envelope, minus the signature. This is exactly what gets signed. */
const envelopeObject = z
  .object({
    v: z.literal(PAYLOAD_VERSION),
    device_id: z.string().min(1).max(64),
    /**
     * Monotonic per-device counter, starting at 1. The server enforces
     * strictly-increasing values, which is what makes a captured payload
     * useless on resubmission.
     */
    seq: z.number().int().min(1),
    /** When the CLI built this batch. Bounds how long a capture stays valid. */
    submitted_at: z.string().datetime(),
    reader_revision: z.literal(2).optional(),
    /** Explicit, atomic full-reader replacement. Signed; never incremental. */
    replace_agents: z.array(z.enum(["codex", "cursor"])).min(1).max(2).optional(),
    buckets: z.array(bucketSchema).max(2000),
    bridge: bridgeSnapshotSchema.optional(),
  })
  .strict();

export const envelopeSchema = envelopeObject.refine(p => p.buckets.length > 0 || !!p.bridge, "A submission needs buckets or a bridge snapshot");
export type Envelope = z.infer<typeof envelopeSchema>;

export const payloadSchema = envelopeObject
  .extend({
    sig: z.string().regex(/^[A-Za-z0-9_-]+$/, "sig must be base64url"),
  })
  .strict().refine(p => p.buckets.length > 0 || !!p.bridge, "A submission needs buckets or a bridge snapshot");

export type IngestPayload = z.infer<typeof payloadSchema>;

/**
 * `sha256(device_id|hour|agent|model)` — `SPEC.md#3.3`.
 *
 * Derived from `device_id`, which is why signing matters: without a signature,
 * anyone who learns your `device_id` could squat your dedupe slots and get your
 * real buckets rejected as replays.
 */
export function dedupeKey(
  deviceId: string,
  hour: string,
  agent: string,
  model: string,
): string {
  return createHash("sha256")
    .update([deviceId, hour, agent, model].join("|"), "utf8")
    .digest("hex");
}

/** Strip `sig` and canonicalize — the one definition both signer and verifier use. */
function signingInput(payload: Envelope): Buffer {
  const { v, device_id, seq, submitted_at, buckets, reader_revision, replace_agents, bridge } = payload;
  return canonicalBytes({ v, device_id, seq, submitted_at, buckets,
    ...(reader_revision ? { reader_revision } : {}), ...(replace_agents ? { replace_agents } : {}), ...(bridge ? { bridge } : {}) });
}

/** Sign an envelope, returning the complete payload ready to POST. */
export function signPayload(
  envelope: Envelope,
  privateKeyPem: PrivateKeyPem,
): IngestPayload {
  return { ...envelope, sig: signBytes(signingInput(envelope), privateKeyPem) };
}

/** Verify a payload's signature against a device's registered public key. */
export function verifyPayload(
  payload: IngestPayload,
  publicKey: PublicKeyB64,
): boolean {
  try {
    return verifyBytes(signingInput(payload), payload.sig, publicKey);
  } catch {
    // A payload whose contents cannot be canonicalized cannot have been signed
    // by us, so it fails closed rather than 500-ing the handler.
    return false;
  }
}
