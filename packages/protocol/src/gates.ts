/**
 * Server-side plausibility gates — `SPEC.md#3.4`.
 *
 * Two severities, following the spec's rule that "false positives on a heavy
 * user are worse than a slow cheat":
 *
 *   reject  the bucket is structurally invalid or physically impossible. The
 *           row is refused and reported in `rejected[]`.
 *   flag    the bucket is suspicious or unpriceable. It is stored, `flags[]`
 *           reports it, and repeat offenders shadow-freeze rather than 400.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DEVIATION FROM SPEC — the `cache_read <= k * input_tokens` gate is wrong.
 *
 * `SPEC.md#3.4` proposes "`cache_read_tokens` must be <= a sane multiple of
 * `input_tokens`". Measured against real Claude Code transcripts, that gate
 * rejects essentially all legitimate traffic. `input_tokens` is only the
 * *uncached* remainder of the prompt, so on a warm cache it collapses to single
 * digits while `cache_read` is the whole conversation prefix:
 *
 *     input_tokens=2   cache_read_input_tokens=16857    ratio 8428:1
 *     input_tokens=2   cache_read_input_tokens=31974    ratio 15987:1
 *
 * There is no "sane multiple" — the ratio is unbounded by construction, and it
 * is *highest* for the best-behaved users. Any threshold that admits the rows
 * above admits any forgery too.
 *
 * The physically grounded invariant is the context window: for one call, the
 * model cannot read more than its window, whatever the split between fresh,
 * cached, and newly-written tokens. So we gate
 *
 *     (input + cache_read + cache_write) / calls  <=  context_window
 *
 * which is a real ceiling, tied to a published number, and cannot be inflated
 * by claiming a warm cache. `#4.2`'s `cache_ratio` signal has the mirror-image
 * problem and needs redefining before M2 — see the note at the bottom.
 * ────────────────────────────────────────────────────────────────────────────
 */

import type { Bucket, Envelope } from "./payload.js";
import { dedupeKey } from "./payload.js";
import { contextWindowFor, costMicros, isKnownModel } from "./models.js";

/** Largest `max_tokens` any current model accepts, plus headroom. */
export const MAX_OUTPUT_TOKENS_PER_CALL = 128_000;

/**
 * Accounting headroom on per-call ceilings. Token counts are summed across a
 * whole hour and divided by `calls`, so a single long call paired with several
 * short ones can nudge the average; 5% absorbs that without admitting a
 * doubling.
 */
export const CEILING_TOLERANCE = 1.05;

/**
 * Calls per hour. 32 concurrent agent sessions each completing a call every 30
 * seconds is already an implausible amount of machinery for one device; well
 * above any real user, well below a scripted flood.
 */
export const MAX_CALLS_PER_HOUR = 4_000;

/** Commits per hour per device. Rebases and imports are bursty; be generous. */
export const MAX_COMMITS_PER_HOUR = 500;

/** How far ahead of the server a device's clock may be. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * How stale a signed batch may be on arrival. This is the replay window: past
 * it, a captured payload is refused on `submitted_at` alone, independent of the
 * `seq` counter and the `dedupe_key` constraint.
 */
export const MAX_SUBMISSION_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * How far back a *bucket* may be dated. Unlike `submitted_at`, this must be
 * generous: `#6.2` requires that a laptop offline for days can still submit
 * backdated buckets.
 */
export const MAX_BUCKET_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Relative disagreement tolerated between claimed and recomputed cost. */
export const COST_TOLERANCE = 0.05;

export type GateCode =
  | "dedupe_key_mismatch"
  | "bucket_in_future"
  | "bucket_too_old"
  | "submission_in_future"
  | "submission_too_old"
  | "context_window_exceeded"
  | "output_per_call_exceeded"
  | "calls_without_tokens"
  | "tokens_without_calls"
  | "calls_per_hour_exceeded"
  | "commits_per_hour_exceeded"
  | "unknown_model"
  | "cost_mismatch";

export interface GateViolation {
  code: GateCode;
  /** Index into `envelope.buckets`, or -1 for envelope-level violations. */
  bucketIndex: number;
  /** Operator-facing detail. Safe to log and to return to the client. */
  detail: string;
}

export interface GateResult {
  rejects: GateViolation[];
  flags: GateViolation[];
}

export interface GateOptions {
  /** Server clock at validation time. Injected so tests are deterministic. */
  now?: Date;
}

function violation(code: GateCode, bucketIndex: number, detail: string): GateViolation {
  return { code, bucketIndex, detail };
}

/**
 * Run every gate over a signed envelope.
 *
 * Signature verification is the caller's job and must happen first — gating an
 * unsigned payload tells you nothing about who sent it.
 */
export function runGates(envelope: Envelope, options: GateOptions = {}): GateResult {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const rejects: GateViolation[] = [];
  const flags: GateViolation[] = [];

  const submittedMs = Date.parse(envelope.submitted_at);
  if (submittedMs - nowMs > MAX_CLOCK_SKEW_MS) {
    rejects.push(
      violation(
        "submission_in_future",
        -1,
        `submitted_at ${envelope.submitted_at} is ${Math.round((submittedMs - nowMs) / 1000)}s ahead of the server`,
      ),
    );
  }
  if (nowMs - submittedMs > MAX_SUBMISSION_AGE_MS) {
    rejects.push(
      violation(
        "submission_too_old",
        -1,
        `submitted_at ${envelope.submitted_at} is older than the ${MAX_SUBMISSION_AGE_MS / 3_600_000}h replay window`,
      ),
    );
  }

  envelope.buckets.forEach((bucket, i) => {
    gateBucket(bucket, i, envelope.device_id, nowMs, rejects, flags);
  });

  return { rejects, flags };
}

function gateBucket(
  bucket: Bucket,
  i: number,
  deviceId: string,
  nowMs: number,
  rejects: GateViolation[],
  flags: GateViolation[],
): void {
  // Recompute rather than trust. A mismatched key means either a broken client
  // or an attempt to occupy a dedupe slot that isn't this device's to claim.
  const expected = dedupeKey(deviceId, bucket.hour, bucket.agent, bucket.model);
  if (bucket.dedupe_key !== expected) {
    rejects.push(
      violation("dedupe_key_mismatch", i, "dedupe_key does not match device_id|hour|agent|model"),
    );
  }

  const hourMs = Date.parse(bucket.hour);
  if (hourMs - nowMs > MAX_CLOCK_SKEW_MS) {
    rejects.push(violation("bucket_in_future", i, `hour ${bucket.hour} is in the future`));
  }
  if (nowMs - hourMs > MAX_BUCKET_AGE_MS && !bucket.historical) {
    // Older activity requires an explicit signed archive marker. It remains
    // useful for analytics, but must not be promoted into competition.
    rejects.push(
      violation(
        "bucket_too_old",
        i,
        `hour ${bucket.hour} predates the ${MAX_BUCKET_AGE_MS / 86_400_000}-day ingest horizon; use sync --all for analytics-only history`,
      ),
    );
  }

  const totalInput =
    bucket.input_tokens + bucket.cache_read_tokens + bucket.cache_write_tokens;
  const anyTokens = totalInput + bucket.output_tokens;

  if (bucket.calls === 0 && anyTokens > 0) {
    rejects.push(
      violation("tokens_without_calls", i, `${anyTokens} tokens reported across 0 calls`),
    );
  } else if (bucket.calls > 0 && anyTokens === 0) {
    // Not impossible (a call can fail before billing), but not useful either.
    flags.push(violation("calls_without_tokens", i, `${bucket.calls} calls reported with 0 tokens`));
  }

  if (bucket.calls > MAX_CALLS_PER_HOUR) {
    rejects.push(
      violation(
        "calls_per_hour_exceeded",
        i,
        `${bucket.calls} calls in one hour exceeds the ${MAX_CALLS_PER_HOUR} ceiling`,
      ),
    );
  }

  if (bucket.calls > 0) {
    // The real ceiling — see the deviation note at the top of this file.
    const window = contextWindowFor(bucket.model);
    const inputPerCall = totalInput / bucket.calls;
    if (inputPerCall > window * CEILING_TOLERANCE) {
      rejects.push(
        violation(
          "context_window_exceeded",
          i,
          `${Math.round(inputPerCall)} input tokens/call exceeds ${bucket.model}'s ${window} context window`,
        ),
      );
    }

    const outputPerCall = bucket.output_tokens / bucket.calls;
    if (outputPerCall > MAX_OUTPUT_TOKENS_PER_CALL * CEILING_TOLERANCE) {
      rejects.push(
        violation(
          "output_per_call_exceeded",
          i,
          `${Math.round(outputPerCall)} output tokens/call exceeds the ${MAX_OUTPUT_TOKENS_PER_CALL} ceiling`,
        ),
      );
    }
  }

  if (bucket.commits > MAX_COMMITS_PER_HOUR) {
    flags.push(
      violation(
        "commits_per_hour_exceeded",
        i,
        `${bucket.commits} commits in one hour exceeds the ${MAX_COMMITS_PER_HOUR} ceiling`,
      ),
    );
  }

  // NOTE deliberately absent: `sessions_completed + sessions_abandoned <=
  // sessions_started`, and `edits_reverted <= edits_applied`. Both are true
  // over a session's lifetime but false inside a single hour — a session that
  // starts at 13:58 and finishes at 14:03 books its start and its completion in
  // different buckets. Gating on them would reject correct data from anyone
  // whose session crosses the top of an hour, which is most people.

  // Metadata-only activity makes no token/cost claim to price.
  if (bucket.calls === 0 && bucket.input_tokens + bucket.output_tokens + bucket.cache_write_tokens + bucket.cache_read_tokens + bucket.cost_micros === 0) return;
  if (!isKnownModel(bucket.model)) {
    flags.push(
      violation(
        "unknown_model",
        i,
        `${bucket.model}: pricing unavailable; excluded from the estimated cost (not free usage)`,
      ),
    );
    return; // No basis on which to check the cost claim.
  }

  // The client computes cost because only it knows the 5m/1h cache-write split.
  // The server re-derives an approximation and flags disagreement rather than
  // rejecting: the split is invisible here, so a legitimate bucket can differ.
  const floor = costMicros(bucket.model, {
    inputTokens: bucket.input_tokens,
    outputTokens: bucket.output_tokens,
    cacheWrite5mTokens: bucket.cache_write_tokens,
    cacheReadTokens: bucket.cache_read_tokens,
  }, "base");
  const ceiling = costMicros(bucket.model, {
    inputTokens: bucket.input_tokens,
    outputTokens: bucket.output_tokens,
    cacheWrite1hTokens: bucket.cache_write_tokens,
    cacheReadTokens: bucket.cache_read_tokens,
  });
  // Per-request context bands and sub-micro rounding aren't recoverable from
  // an hourly sum. Base-to-long-context rates bound the real per-call total.
  const low = Math.max(0, Math.floor(floor * (1 - COST_TOLERANCE) - bucket.calls));
  const high = Math.ceil(ceiling * (1 + COST_TOLERANCE) + bucket.calls);
  if (bucket.cost_micros < low || bucket.cost_micros > high) {
    flags.push(
      violation(
        "cost_mismatch",
        i,
        `cost_micros ${bucket.cost_micros} outside the plausible range ${low}..${high} for ${bucket.model}`,
      ),
    );
  }
}

/*
 * Related M2 problem, recorded here because this file is where the evidence is.
 *
 * `#4.2` defines `cache_ratio = cache_read / (input + cache_read)` as an
 * efficiency signal. With `input_tokens` collapsing to single digits on a warm
 * cache, that expression pins to ~0.9999 for every competent user and carries
 * no information — it cannot discriminate, so `w1` would be tuning noise.
 *
 * `cache_read / (cache_read + cache_write)` does discriminate: it measures
 * reuse against re-caching, which is where the money actually goes. On the
 * transcript sampled above it moves across 0.80 and 1.00 within one session.
 * Revisit when the `#4.4` simulation harness lands — that gate is the place to
 * prove which definition survives `cache_gamer`.
 */
