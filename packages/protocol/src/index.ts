export { canonicalJson, canonicalBytes, CanonicalJsonError } from "./canonical.js";
export { bridgeSnapshotSchema, bridgeUrl, fetchBridgeSnapshot, type BridgeSnapshot } from "./bridge.js";

export {
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  KeyFormatError,
  generateDeviceKeyPair,
  publicKeyFromPem,
  importPublicKey,
  signBytes,
  verifyBytes,
  type PublicKeyB64,
  type PrivateKeyPem,
  type DeviceKeyPair,
} from "./keys.js";

export {
  PAYLOAD_VERSION,
  hourSchema,
  bucketSchema,
  envelopeSchema,
  payloadSchema,
  dedupeKey,
  signPayload,
  verifyPayload,
  type Bucket,
  type Envelope,
  type IngestPayload,
} from "./payload.js";

export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER_1H,
  CACHE_WRITE_MULTIPLIER_5M,
  contextWindowFor,
  costMicros,
  isKnownModel,
  knownModels,
  lookupModel,
  normalizeModelId,
  type ModelInfo,
  type TokenCounts,
} from "./models.js";

export {
  CEILING_TOLERANCE,
  COST_TOLERANCE,
  MAX_BUCKET_AGE_MS,
  MAX_CALLS_PER_HOUR,
  MAX_CLOCK_SKEW_MS,
  MAX_COMMITS_PER_HOUR,
  MAX_OUTPUT_TOKENS_PER_CALL,
  MAX_SUBMISSION_AGE_MS,
  runGates,
  type GateCode,
  type GateOptions,
  type GateResult,
  type GateViolation,
} from "./gates.js";
