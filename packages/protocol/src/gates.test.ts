import { describe, expect, it } from "vitest";
import { costMicros } from "./models.js";
import { dedupeKey, PAYLOAD_VERSION, type Bucket, type Envelope } from "./payload.js";
import {
  MAX_CALLS_PER_HOUR,
  MAX_COMMITS_PER_HOUR,
  runGates,
  type GateCode,
} from "./gates.js";

const DEVICE = "dev_01HQ8Z";
const NOW = new Date("2026-09-08T13:59:00.000Z");
const HOUR = "2026-09-08T13:00:00Z";

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  const base = {
    hour: HOUR,
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
    ...overrides,
  };
  const withCost = {
    ...base,
    cost_micros:
      overrides.cost_micros ??
      costMicros(base.model, {
        inputTokens: base.input_tokens,
        outputTokens: base.output_tokens,
        cacheWrite5mTokens: base.cache_write_tokens,
        cacheReadTokens: base.cache_read_tokens,
      }),
  };
  return {
    ...withCost,
    dedupe_key:
      overrides.dedupe_key ?? dedupeKey(DEVICE, base.hour, base.agent, base.model),
  };
}

function envelope(buckets: Bucket[], overrides: Partial<Envelope> = {}): Envelope {
  return {
    v: PAYLOAD_VERSION,
    device_id: DEVICE,
    seq: 1,
    submitted_at: NOW.toISOString(),
    buckets,
    ...overrides,
  };
}

function gate(buckets: Bucket[], overrides: Partial<Envelope> = {}) {
  const result = runGates(envelope(buckets, overrides), { now: NOW });
  return {
    rejects: result.rejects.map((v) => v.code),
    flags: result.flags.map((v) => v.code),
    raw: result,
  };
}

function expectClean(buckets: Bucket[], overrides: Partial<Envelope> = {}) {
  const { rejects, flags, raw } = gate(buckets, overrides);
  expect({ rejects, flags, detail: raw.rejects.concat(raw.flags).map((v) => v.detail) }).toEqual({
    rejects: [],
    flags: [],
    detail: [],
  });
}

describe("runGates", () => {
  it("passes a normal bucket", () => {
    expectClean([bucket()]);
  });

  /**
   * Regression test for the spec deviation documented in `gates.ts`.
   *
   * These are real numbers lifted from a Claude Code transcript, where
   * `input_tokens` is only the uncached remainder of the prompt. The spec's
   * proposed `cache_read <= k * input_tokens` gate rejects all of them; the
   * context-window gate must accept every one.
   */
  describe("accepts real warm-cache traffic (spec #3.4 deviation)", () => {
    const observed: Array<[input: number, cacheWrite: number, cacheRead: number, output: number]> = [
      [2, 4310, 16857, 313],
      [2, 0, 21167, 72],
      [2, 0, 21698, 1415],
      [2, 0, 29260, 1195],
      [2, 0, 30707, 2584],
      [2, 0, 31974, 968],
    ];

    for (const [input, cacheWrite, cacheRead, output] of observed) {
      it(`input=${input} cache_read=${cacheRead} (ratio ${Math.round(cacheRead / input)}:1)`, () => {
        expectClean([
          bucket({
            calls: 1,
            input_tokens: input,
            cache_write_tokens: cacheWrite,
            cache_read_tokens: cacheRead,
            output_tokens: output,
          }),
        ]);
      });
    }

    it("accepts the whole hour aggregated, which is what actually ships", () => {
      const sum = observed.reduce(
        (acc, [i, w, r, o]) => ({
          input_tokens: acc.input_tokens + i,
          cache_write_tokens: acc.cache_write_tokens + w,
          cache_read_tokens: acc.cache_read_tokens + r,
          output_tokens: acc.output_tokens + o,
        }),
        { input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0 },
      );
      expectClean([bucket({ ...sum, calls: observed.length })]);
    });
  });

  describe("dedupe_key", () => {
    it("rejects a key that does not match the envelope's device", () => {
      // Squatting another device's dedupe slot.
      const foreign = dedupeKey("dev_victim", HOUR, "claude-code", "claude-opus-5");
      expect(gate([bucket({ dedupe_key: foreign })]).rejects).toContain<GateCode>(
        "dedupe_key_mismatch",
      );
    });

    it("rejects a key computed over the wrong hour", () => {
      const wrongHour = dedupeKey(DEVICE, "2026-09-08T12:00:00Z", "claude-code", "claude-opus-5");
      expect(gate([bucket({ dedupe_key: wrongHour })]).rejects).toContain<GateCode>(
        "dedupe_key_mismatch",
      );
    });
  });

  describe("time", () => {
    it("accepts old historical buckets but still enforces plausibility and future dates", () => {
      expectClean([bucket({ hour: "2024-01-01T09:00:00Z", historical: true })]);
      expect(gate([bucket({ historical: true, hour: "2024-01-01T09:00:00Z", calls: 0 })]).rejects)
        .toContain("tokens_without_calls");
      expect(gate([bucket({ historical: true, hour: "2026-09-09T13:00:00Z" })]).rejects)
        .toContain("bucket_in_future");
    });

    it("rejects a bucket dated in the future", () => {
      expect(gate([bucket({ hour: "2026-09-09T13:00:00Z" })]).rejects).toContain<GateCode>(
        "bucket_in_future",
      );
    });

    it("tolerates small clock skew on the current hour", () => {
      // A device a couple of minutes fast must not have its work refused.
      expectClean([bucket({ hour: "2026-09-08T14:00:00Z" })], {
        submitted_at: "2026-09-08T14:01:00.000Z",
      });
    });

    it("accepts backdated buckets from a laptop that was offline (#6.2)", () => {
      expectClean([bucket({ hour: "2026-09-05T09:00:00Z", dedupe_key: dedupeKey(DEVICE, "2026-09-05T09:00:00Z", "claude-code", "claude-opus-5") })]);
    });

    it("rejects a bucket past the 90-day ingest horizon", () => {
      const old = "2026-01-01T09:00:00Z";
      expect(
        gate([
          bucket({ hour: old, dedupe_key: dedupeKey(DEVICE, old, "claude-code", "claude-opus-5") }),
        ]).rejects,
      ).toContain<GateCode>("bucket_too_old");
    });

    it("rejects a batch submitted from the future", () => {
      expect(
        gate([bucket()], { submitted_at: "2026-09-09T00:00:00.000Z" }).rejects,
      ).toContain<GateCode>("submission_in_future");
    });

    it("rejects a batch replayed outside the 24h window", () => {
      expect(
        gate([bucket()], { submitted_at: "2026-09-06T13:00:00.000Z" }).rejects,
      ).toContain<GateCode>("submission_too_old");
    });
  });

  describe("physical ceilings", () => {
    it("rejects more input tokens per call than the model's context window", () => {
      // 1 call claiming 2M tokens of context on a 1M-window model.
      const { rejects, raw } = gate([
        bucket({ calls: 1, input_tokens: 2_000_000, cache_read_tokens: 0, cache_write_tokens: 0 }),
      ]);
      expect(rejects).toContain<GateCode>("context_window_exceeded");
      expect(raw.rejects[0]!.detail).toMatch(/1000000 context window/);
    });

    it("counts cached tokens toward the window, so a warm cache is no loophole", () => {
      expect(
        gate([
          bucket({ calls: 1, input_tokens: 2, cache_read_tokens: 1_500_000, cache_write_tokens: 0 }),
        ]).rejects,
      ).toContain<GateCode>("context_window_exceeded");
    });

    it("applies the smaller window of a smaller model", () => {
      // 500k input is fine on Opus 5 but impossible on Haiku 4.5's 200k window.
      const haiku = { model: "claude-haiku-4-5", calls: 1, input_tokens: 500_000, cache_read_tokens: 0, cache_write_tokens: 0 };
      expect(
        gate([
          bucket({ ...haiku, dedupe_key: dedupeKey(DEVICE, HOUR, "claude-code", "claude-haiku-4-5") }),
        ]).rejects,
      ).toContain<GateCode>("context_window_exceeded");
    });

    it("rejects more output tokens per call than any model can emit", () => {
      expect(
        gate([bucket({ calls: 1, output_tokens: 500_000 })]).rejects,
      ).toContain<GateCode>("output_per_call_exceeded");
    });

    it("rejects tokens reported against zero calls", () => {
      expect(gate([bucket({ calls: 0 })]).rejects).toContain<GateCode>("tokens_without_calls");
    });

    it("rejects an implausible call count", () => {
      expect(
        gate([bucket({ calls: MAX_CALLS_PER_HOUR + 1 })]).rejects,
      ).toContain<GateCode>("calls_per_hour_exceeded");
    });

    it("flags, but stores, calls that billed nothing", () => {
      const { rejects, flags } = gate([
        bucket({
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_micros: 0,
        }),
      ]);
      expect(rejects).toEqual([]);
      expect(flags).toContain<GateCode>("calls_without_tokens");
    });

    it("flags an implausible commit count without rejecting it", () => {
      const { rejects, flags } = gate([bucket({ commits: MAX_COMMITS_PER_HOUR + 1 })]);
      expect(rejects).toEqual([]);
      expect(flags).toContain<GateCode>("commits_per_hour_exceeded");
    });
  });

  describe("hour-boundary session counts are deliberately not gated", () => {
    // A session starting at 13:58 and finishing at 14:03 books its start and
    // its completion in different buckets, so neither of these is an anomaly.
    it("allows completions with no starts in the same hour", () => {
      expectClean([bucket({ sessions_started: 0, sessions_completed: 3, sessions_abandoned: 0 })]);
    });

    it("allows more reverts than applies in the same hour", () => {
      expectClean([bucket({ edits_applied: 0, edits_reverted: 4 })]);
    });
  });

  describe("cost", () => {
    it("accepts a cost priced at the 1h cache-write multiplier", () => {
      // The server cannot see the 5m/1h split, so both ends must pass.
      expectClean([
        bucket({
          cost_micros: costMicros("claude-opus-5", {
            inputTokens: 12043,
            outputTokens: 3311,
            cacheWrite1hTokens: 8100,
            cacheReadTokens: 96500,
          }),
        }),
      ]);
    });

    it("flags an understated cost", () => {
      expect(gate([bucket({ cost_micros: 1 })]).flags).toContain<GateCode>("cost_mismatch");
    });

    it("flags an overstated cost", () => {
      expect(gate([bucket({ cost_micros: 99_000_000 })]).flags).toContain<GateCode>(
        "cost_mismatch",
      );
    });
  });

  describe("unknown models", () => {
    const unknown = {
      model: "some-future-model",
      dedupe_key: dedupeKey(DEVICE, HOUR, "claude-code", "some-future-model"),
    };

    it("flags rather than rejects, so a new model does not lock a user out", () => {
      const { rejects, flags } = gate([bucket({ ...unknown, cost_micros: 0 })]);
      expect(rejects).toEqual([]);
      expect(flags).toEqual<GateCode[]>(["unknown_model"]);
    });

    it("does not also flag a cost mismatch it cannot assess", () => {
      expect(gate([bucket({ ...unknown, cost_micros: 12345 })]).flags).toEqual<GateCode[]>([
        "unknown_model",
      ]);
    });

    it("still applies the generous fallback window", () => {
      expect(
        gate([
          bucket({ ...unknown, calls: 1, input_tokens: 9_000_000, cache_read_tokens: 0, cache_write_tokens: 0, cost_micros: 0 }),
        ]).rejects,
      ).toContain<GateCode>("context_window_exceeded");
    });
  });

  it("reports the index of the offending bucket", () => {
    const { raw } = gate([bucket(), bucket({ calls: 1, output_tokens: 999_999 })]);
    expect(raw.rejects).toHaveLength(1);
    expect(raw.rejects[0]!.bucketIndex).toBe(1);
  });

  it("normalizes a variant model id rather than treating it as unknown", () => {
    // Claude Code writes "claude-opus-5[1m]" into transcripts.
    const variant = {
      model: "claude-opus-5[1m]",
      dedupe_key: dedupeKey(DEVICE, HOUR, "claude-code", "claude-opus-5[1m]"),
    };
    expectClean([bucket(variant)]);
  });
});
