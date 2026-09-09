import { describe, expect, it } from "vitest";
import { bucketSchema, dedupeKey, costMicros, runGates, PAYLOAD_VERSION } from "@usurp/protocol";
import { hourEnd, hourOf, hourStart, toBuckets } from "./bucket.js";
import type { CommitCounter } from "./git.js";
import type { ApiCall, EditEvent, ReaderResult, SessionRecord } from "./types.js";

const DEVICE = "dev_test";
const CWD = "/Users/dev/project";

function call(overrides: Partial<ApiCall> = {}): ApiCall {
  return {
    messageId: "msg_1",
    timestamp: "2026-09-08T13:10:00.000Z",
    agent: "claude-code",
    model: "claude-opus-5",
    inputTokens: 100,
    outputTokens: 200,
    cacheWrite5mTokens: 300,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 400,
    sessionId: "s1",
    cwd: CWD,
    ...overrides,
  };
}

function result(overrides: Partial<ReaderResult> = {}): ReaderResult {
  return { calls: [], edits: [], sessions: [], warnings: [], ...overrides };
}

function edit(overrides: Partial<EditEvent> = {}): EditEvent {
  return {
    timestamp: "2026-09-08T13:10:00.000Z",
    agent: "claude-code",
    model: "claude-opus-5",
    sessionId: "s1",
    cwd: CWD,
    applied: true,
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "s1",
    agent: "claude-code",
    cwd: CWD,
    startedAt: "2026-09-08T13:10:00.000Z",
    endedAt: "2026-09-08T13:50:00.000Z",
    startModel: "claude-opus-5",
    endModel: "claude-opus-5",
    outcome: "completed",
    ...overrides,
  };
}

class FixedCommitCounter implements CommitCounter {
  readonly seen: Array<{ cwd: string; start: string; end: string }> = [];
  constructor(private readonly n: number) {}
  async count(cwd: string, start: Date, end: Date): Promise<number> {
    this.seen.push({ cwd, start: start.toISOString(), end: end.toISOString() });
    return this.n;
  }
}

const build = (r: ReaderResult, commits?: CommitCounter) =>
  toBuckets(r, { deviceId: DEVICE, commits });

it("prices each request before aggregation and accepts a mix of context bands", async () => {
  const small = call({ model: "gpt-5.6-sol", inputTokens: 200_000, cacheReadTokens: 0, cacheWrite5mTokens: 0 });
  const large = call({ model: "gpt-5.6-sol", inputTokens: 1000, cacheReadTokens: 300_000, cacheWrite5mTokens: 0 });
  const buckets = await build(result({ calls: [small, small, large] }));
  expect(buckets[0]?.cost_micros).toBe(2 * costMicros(small.model, small) + costMicros(large.model, large));
  const gates = runGates({ v: 1, device_id: DEVICE, seq: 1, submitted_at: "2026-09-08T13:59:00Z", buckets }, { now: new Date("2026-09-08T13:59:00Z") });
  expect(gates.rejects).toEqual([]); expect(gates.flags).toEqual([]);
});

describe("hourOf", () => {
  it("truncates to a UTC hour in the exact wire format", () => {
    expect(hourOf("2026-09-08T13:47:52.991Z")).toBe("2026-09-08T13:00:00Z");
  });

  it("normalizes a non-UTC offset to UTC", () => {
    expect(hourOf("2026-09-08T15:47:00+02:00")).toBe("2026-09-08T13:00:00Z");
  });

  it("produces a value the wire schema accepts", () => {
    expect(() =>
      bucketSchema.shape.hour.parse(hourOf("2026-09-08T13:47:52.991Z")),
    ).not.toThrow();
  });

  it("pads single-digit components", () => {
    expect(hourOf("2026-01-02T03:04:05.000Z")).toBe("2026-01-02T03:00:00Z");
  });

  it("throws on an unparseable timestamp", () => {
    expect(() => hourOf("not a date")).toThrow(RangeError);
  });

  it("hourStart/hourEnd bracket exactly one hour", () => {
    const h = "2026-09-08T13:00:00Z";
    expect(hourStart(h).toISOString()).toBe("2026-09-08T13:00:00.000Z");
    expect(hourEnd(h).toISOString()).toBe("2026-09-08T14:00:00.000Z");
  });
});

describe("toBuckets", () => {
  it("sums calls into one bucket per hour/agent/model", async () => {
    const buckets = await build(
      result({
        calls: [
          call({ messageId: "m1" }),
          call({ messageId: "m2", timestamp: "2026-09-08T13:55:00.000Z" }),
        ],
      }),
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({
      hour: "2026-09-08T13:00:00Z",
      agent: "claude-code",
      model: "claude-opus-5",
      input_tokens: 200,
      output_tokens: 400,
      cache_write_tokens: 600,
      cache_read_tokens: 800,
      calls: 2,
    });
  });

  it("splits across hours", async () => {
    const buckets = await build(
      result({
        calls: [
          call({ messageId: "m1", timestamp: "2026-09-08T13:59:59.000Z" }),
          call({ messageId: "m2", timestamp: "2026-09-08T14:00:01.000Z" }),
        ],
      }),
    );

    expect(buckets.map((b) => b.hour)).toEqual([
      "2026-09-08T13:00:00Z",
      "2026-09-08T14:00:00Z",
    ]);
  });

  it("splits across models", async () => {
    const buckets = await build(
      result({
        calls: [
          call({ messageId: "m1", model: "claude-opus-5" }),
          call({ messageId: "m2", model: "claude-sonnet-5" }),
        ],
      }),
    );

    expect(buckets).toHaveLength(2);
    expect(buckets.map((b) => b.model)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  describe("the privacy boundary (#10.1)", () => {
    it("emits only the fields in the published payload schema", async () => {
      const buckets = await build(
        result({
          calls: [call()],
          edits: [edit()],
          sessions: [session()],
        }),
      );

      // `bucketSchema` is `.strict()`, so this fails if any extra field — a
      // cwd, a session id, a file path — survives bucketing.
      for (const bucket of buckets) {
        expect(() => bucketSchema.parse(bucket)).not.toThrow();
      }
    });

    it("carries no cwd or session id, even though the inputs had both", async () => {
      const buckets = await build(result({ calls: [call()], sessions: [session()] }));
      const serialized = JSON.stringify(buckets);

      expect(serialized).not.toContain(CWD);
      expect(serialized).not.toContain("project");
      expect(serialized).not.toContain("s1");
      expect(serialized).not.toContain("msg_1");
    });
  });

  it("computes a dedupe_key bound to the device", async () => {
    const buckets = await build(result({ calls: [call()] }));
    expect(buckets[0]!.dedupe_key).toBe(
      dedupeKey(DEVICE, "2026-09-08T13:00:00Z", "claude-code", "claude-opus-5"),
    );
  });

  it("prices using the 5m/1h cache-write split the wire format cannot carry", async () => {
    const buckets = await build(
      result({
        calls: [call({ cacheWrite5mTokens: 1000, cacheWrite1hTokens: 2000 })],
      }),
    );

    expect(buckets[0]!.cache_write_tokens).toBe(3000);
    expect(buckets[0]!.cost_micros).toBe(
      costMicros("claude-opus-5", {
        inputTokens: 100,
        outputTokens: 200,
        cacheWrite5mTokens: 1000,
        cacheWrite1hTokens: 2000,
        cacheReadTokens: 400,
      }),
    );
  });

  describe("edits", () => {
    it("counts applied and reverted separately", async () => {
      const buckets = await build(
        result({
          edits: [edit({ applied: true }), edit({ applied: true }), edit({ applied: false })],
        }),
      );

      expect(buckets[0]).toMatchObject({ edits_applied: 2, edits_reverted: 1, calls: 0 });
    });
  });

  describe("sessions", () => {
    it("books a start and a completion in the same hour", async () => {
      const buckets = await build(result({ sessions: [session()] }));
      expect(buckets[0]).toMatchObject({
        sessions_started: 1,
        sessions_completed: 1,
        sessions_abandoned: 0,
      });
    });

    it("books a start and a terminal count in different hours when the session spans one", async () => {
      // The reason gates.ts refuses to compare these within an hour.
      const buckets = await build(
        result({
          sessions: [
            session({
              startedAt: "2026-09-08T13:58:00.000Z",
              endedAt: "2026-09-08T14:03:00.000Z",
            }),
          ],
        }),
      );

      expect(buckets).toHaveLength(2);
      expect(buckets[0]).toMatchObject({ sessions_started: 1, sessions_completed: 0 });
      expect(buckets[1]).toMatchObject({ sessions_started: 0, sessions_completed: 1 });
    });

    it("counts an abandoned session", async () => {
      const buckets = await build(result({ sessions: [session({ outcome: "abandoned" })] }));
      expect(buckets[0]).toMatchObject({ sessions_abandoned: 1, sessions_completed: 0 });
    });

    it("books a start but no terminal count for an in-progress session", async () => {
      const buckets = await build(result({ sessions: [session({ outcome: "in_progress" })] }));
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatchObject({
        sessions_started: 1,
        sessions_completed: 0,
        sessions_abandoned: 0,
      });
    });

    it("attributes start and terminal counts to their respective models", async () => {
      const buckets = await build(
        result({
          sessions: [
            session({ startModel: "claude-sonnet-5", endModel: "claude-opus-5" }),
          ],
        }),
      );

      const sonnet = buckets.find((b) => b.model === "claude-sonnet-5");
      const opus = buckets.find((b) => b.model === "claude-opus-5");
      expect(sonnet).toMatchObject({ sessions_started: 1, sessions_completed: 0 });
      expect(opus).toMatchObject({ sessions_started: 0, sessions_completed: 1 });
    });
  });

  describe("commits", () => {
    it("queries git once per hour and cwd, over that exact hour", async () => {
      const counter = new FixedCommitCounter(3);
      const buckets = await build(
        result({ calls: [call({ messageId: "m1" }), call({ messageId: "m2" })] }),
        counter,
      );

      expect(counter.seen).toEqual([
        { cwd: CWD, start: "2026-09-08T13:00:00.000Z", end: "2026-09-08T14:00:00.000Z" },
      ]);
      expect(buckets[0]!.commits).toBe(3);
    });

    it("attributes commits to the model with the most output in that hour and cwd", async () => {
      const buckets = await build(
        result({
          calls: [
            call({ messageId: "m1", model: "claude-sonnet-5", outputTokens: 10 }),
            call({ messageId: "m2", model: "claude-opus-5", outputTokens: 500 }),
          ],
        }),
        new FixedCommitCounter(2),
      );

      expect(buckets.find((b) => b.model === "claude-opus-5")!.commits).toBe(2);
      expect(buckets.find((b) => b.model === "claude-sonnet-5")!.commits).toBe(0);
    });

    it("breaks attribution ties deterministically on model id", async () => {
      const build2 = () =>
        build(
          result({
            calls: [
              call({ messageId: "m1", model: "claude-sonnet-5", outputTokens: 100 }),
              call({ messageId: "m2", model: "claude-opus-5", outputTokens: 100 }),
            ],
          }),
          new FixedCommitCounter(1),
        );

      const [a, b] = [await build2(), await build2()];
      expect(a).toEqual(b);
      expect(a.find((x) => x.commits === 1)!.model).toBe("claude-opus-5");
    });

    it("counts commits per directory when work spans repos", async () => {
      const counter = new FixedCommitCounter(1);
      await build(
        result({
          calls: [
            call({ messageId: "m1", cwd: "/repo/a" }),
            call({ messageId: "m2", cwd: "/repo/b" }),
          ],
        }),
        counter,
      );

      expect(counter.seen.map((s) => s.cwd).sort()).toEqual(["/repo/a", "/repo/b"]);
    });

    it("defaults to zero commits when no counter is supplied", async () => {
      const buckets = await build(result({ calls: [call()] }));
      expect(buckets[0]!.commits).toBe(0);
    });
  });

  describe("determinism", () => {
    it("is byte-identical across runs on identical input", async () => {
      // What makes re-reading a partially observed hour a true no-op.
      const input = () =>
        result({
          calls: [
            call({ messageId: "m2", model: "claude-sonnet-5" }),
            call({ messageId: "m1", timestamp: "2026-09-08T14:10:00.000Z" }),
            call({ messageId: "m3" }),
          ],
          edits: [edit()],
          sessions: [session()],
        });

      const a = JSON.stringify(await build(input(), new FixedCommitCounter(2)));
      const b = JSON.stringify(await build(input(), new FixedCommitCounter(2)));
      expect(a).toBe(b);
    });

    it("sorts by hour, then agent, then model", async () => {
      const buckets = await build(
        result({
          calls: [
            call({ messageId: "m1", timestamp: "2026-09-08T14:00:00.000Z", model: "claude-sonnet-5" }),
            call({ messageId: "m2", timestamp: "2026-09-08T13:00:00.000Z", model: "claude-sonnet-5" }),
            call({ messageId: "m3", timestamp: "2026-09-08T13:00:00.000Z", model: "claude-opus-5" }),
          ],
        }),
      );

      expect(buckets.map((b) => `${b.hour} ${b.model}`)).toEqual([
        "2026-09-08T13:00:00Z claude-opus-5",
        "2026-09-08T13:00:00Z claude-sonnet-5",
        "2026-09-08T14:00:00Z claude-sonnet-5",
      ]);
    });
  });

  it("produces buckets that pass the server's own gates", async () => {
    // End-to-end: what the reader builds must survive what the server enforces.
    const buckets = await build(
      result({
        calls: [
          // Real warm-cache shape, which the spec's proposed gate would reject.
          call({ messageId: "m1", inputTokens: 2, cacheReadTokens: 31974, cacheWrite5mTokens: 0, outputTokens: 968 }),
          call({ messageId: "m2", inputTokens: 2, cacheReadTokens: 16857, cacheWrite1hTokens: 4310, cacheWrite5mTokens: 0, outputTokens: 313 }),
        ],
        edits: [edit(), edit({ applied: false })],
        sessions: [session()],
      }),
      new FixedCommitCounter(2),
    );

    const outcome = runGates(
      {
        v: PAYLOAD_VERSION,
        device_id: DEVICE,
        seq: 1,
        submitted_at: "2026-09-08T14:00:00.000Z",
        buckets,
      },
      { now: new Date("2026-09-08T14:00:00.000Z") },
    );

    expect({ rejects: outcome.rejects, flags: outcome.flags }).toEqual({ rejects: [], flags: [] });
  });

  it("returns nothing for an empty read", async () => {
    expect(await build(result())).toEqual([]);
  });
});
