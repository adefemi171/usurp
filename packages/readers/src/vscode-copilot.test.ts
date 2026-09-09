/**
 * Copilot Chat reader — `SPEC.md#3.1`.
 *
 * The property under test is the one that would silently corrupt a board: a
 * journal line *revises* a request rather than adding one, so a naive reader
 * counts the same request once per revision. Everything else here is about not
 * inventing data Copilot does not record.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CopilotReader, defaultRoots, normalizeCopilotModel, replayJournal } from "./vscode-copilot.js";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const T0 = new Date("2026-09-09T10:00:00.000Z").getTime();

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A workspaceStorage root holding one chat session journal. */
async function root(lines: unknown[], workspace = "ws1", session = "s1"): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "usurp-copilot-"));
  dirs.push(base);
  const dir = join(base, workspace, "chatSessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${session}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  return base;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "request_a",
    timestamp: T0,
    responseTimestamp: T0 + 1000,
    modelId: "copilot/claude-opus-4.8",
    promptTokens: 25_000,
    completionTokens: 1_200,
    copilotCredits: 12.4,
    result: { metadata: { resolvedModel: "claude-opus-4-8", outputTokens: 965, cacheKey: "file:///Users/x/proj" } },
    response: [],
    ...overrides,
  };
}

function snapshot(requests: unknown[]) {
  return { kind: 0, v: { version: 3, sessionId: "s1", creationDate: T0, requests } };
}

describe("replayJournal", () => {
  it("applies a set mutation in place rather than appending a record", () => {
    const text = [
      JSON.stringify(snapshot([request({ completionTokens: 100 })])),
      // VS Code rewrites the whole request when the turn finishes.
      JSON.stringify({ kind: 1, k: ["requests", 0, "completionTokens"], v: 1_200 }),
    ].join("\n");

    const root = replayJournal(text);
    const requests = root!.requests as Array<Record<string, unknown>>;
    // One request, revised — not two.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.completionTokens).toBe(1_200);
  });

  it("applies an append mutation", () => {
    const text = [
      JSON.stringify(snapshot([request()])),
      JSON.stringify({ kind: 2, k: ["requests"], v: [request({ requestId: "request_b" })] }),
    ].join("\n");

    const requests = replayJournal(text)!.requests as unknown[];
    expect(requests).toHaveLength(2);
  });

  it("keeps everything before a truncated final line", () => {
    // VS Code writes these live, so a half-flushed tail is the normal state of
    // a session that is open right now.
    const text = `${JSON.stringify(snapshot([request()]))}\n{"kind":1,"k":["requ`;
    const warnings: string[] = [];
    const root = replayJournal(text, (m) => warnings.push(m));
    expect((root!.requests as unknown[]).length).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("returns undefined when no snapshot ever arrives", () => {
    expect(replayJournal('{"kind":1,"k":["requests"],"v":[]}')).toBeUndefined();
    expect(replayJournal("")).toBeUndefined();
  });
});

describe("normalizeCopilotModel", () => {
  it("strips the routing prefix", () => {
    expect(normalizeCopilotModel("copilot/claude-opus-4.8")).toBe("claude-opus-4-8");
    expect(normalizeCopilotModel("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("dashes a dotted Claude version but leaves other vendors' ids alone", () => {
    expect(normalizeCopilotModel("claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
    // `gpt-5.6-sol` is the published id; rewriting the dot would invent one.
    expect(normalizeCopilotModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("discards the model picker placeholder", () => {
    expect(normalizeCopilotModel("auto")).toBe("");
    expect(normalizeCopilotModel("")).toBe("");
  });
});

describe("CopilotReader", () => {
  it("reads metadata-only usage from older Copilot journals", async () => {
    const result = await new CopilotReader().read({
      rootDir: await root([snapshot([request({
        promptTokens: undefined,
        completionTokens: undefined,
        modelId: "copilot/auto",
        result: { metadata: { promptTokens: 18593, outputTokens: 287, resolvedModel: "claude-sonnet-4-6" } },
      })])]),
      now: NOW,
    });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ model: "claude-sonnet-4-6", inputTokens: 18593, outputTokens: 287 });
  });

  it("preserves explicit zero request tokens instead of taking a metadata fallback", async () => {
    const result = await new CopilotReader().read({
      rootDir: await root([snapshot([request({
        promptTokens: 0,
        result: { metadata: { promptTokens: 18593 } },
      })])]),
      now: NOW,
    });
    expect(result.calls[0]?.inputTokens).toBe(0);
  });

  it("reads one call per request and prefers the canonical model id", async () => {
    const reader = new CopilotReader();
    const result = await reader.read({ rootDir: await root([snapshot([request()])]), now: NOW });

    expect(result.warnings).toEqual([]);
    expect(result.calls).toHaveLength(1);
    const call = result.calls[0]!;
    expect(call.agent).toBe("vscode-copilot");
    // `resolvedModel`, not the dotted `modelId`.
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.inputTokens).toBe(25_000);
    // The request-level figure, which includes reasoning tokens.
    expect(call.outputTokens).toBe(1_200);
    expect(call.cwd).toBe("/Users/x/proj");
  });

  it("reports zero cache tokens rather than guessing a split", async () => {
    const result = await new CopilotReader().read({
      rootDir: await root([snapshot([request()])]),
      now: NOW,
    });
    const call = result.calls[0]!;
    // Copilot exposes no cache accounting. `signals.ts` turns a zero cache
    // total into a null signal, which `zScores` scores at the cohort mean —
    // so zero is the value that leaves a Copilot user un-penalised, and any
    // invented number would break that.
    expect(call.cacheReadTokens).toBe(0);
    expect(call.cacheWrite5mTokens).toBe(0);
    expect(call.cacheWrite1hTokens).toBe(0);
  });

  it("counts a revised request once", async () => {
    const dir = await root([
      snapshot([request({ completionTokens: 100 })]),
      { kind: 1, k: ["requests", 0, "completionTokens"], v: 1_200 },
      { kind: 1, k: ["requests", 0, "promptTokens"], v: 26_000 },
    ]);

    const result = await new CopilotReader().read({ rootDir: dir, now: NOW });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.outputTokens).toBe(1_200);
    expect(result.calls[0]!.inputTokens).toBe(26_000);
  });

  it("de-duplicates the same request id across two workspace hashes", async () => {
    // Reopening a folder from a different path gives the same session a second
    // workspace directory.
    const base = await mkdtemp(join(tmpdir(), "usurp-copilot-"));
    dirs.push(base);
    for (const ws of ["hashA", "hashB"]) {
      const dir = join(base, ws, "chatSessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "s1.jsonl"), JSON.stringify(snapshot([request()])));
    }

    const result = await new CopilotReader().read({ rootDir: base, now: NOW });
    expect(result.calls).toHaveLength(1);
  });

  it("skips a request that never reached a model", async () => {
    const dir = await root([
      snapshot([
        request(),
        request({
          requestId: "request_failed",
          promptTokens: undefined,
          completionTokens: undefined,
          result: { errorDetails: { code: "badRequest", message: "failed" }, metadata: {} },
        }),
      ]),
    ]);

    const result = await new CopilotReader().read({ rootDir: dir, now: NOW });
    // A cancelled or rejected turn is not a billed call. Counting it would add
    // a zero-cost call and drag the per-call averages `#3.4`'s gates check.
    expect(result.calls).toHaveLength(1);
  });

  it("counts edit tools as applied and undo events as reverted", async () => {
    const dir = await root([
      snapshot([
        request({
          response: [
            { kind: "toolInvocationSerialized", toolId: "copilot_replaceString", isComplete: true },
            { kind: "toolInvocationSerialized", toolId: "copilot_createFile", isComplete: true },
            // Not an edit tool.
            { kind: "toolInvocationSerialized", toolId: "copilot_readFile", isComplete: true },
            // Never finished — a cancelled turn, neither applied nor reverted.
            { kind: "toolInvocationSerialized", toolId: "copilot_applyPatch", isComplete: false },
          ],
          // `eventKind: 2` is Undo — the user took the edit back.
          editedFileEvents: [{ eventKind: 2 }, { eventKind: 1 }],
        }),
      ]),
    ]);

    const result = await new CopilotReader().read({ rootDir: dir, now: NOW });
    expect(result.edits.filter((e) => e.applied)).toHaveLength(2);
    // One Undo. `eventKind: 1` (Keep) is not a revert.
    expect(result.edits.filter((e) => !e.applied)).toHaveLength(1);
  });

  it("treats a still-warm session as in progress", async () => {
    const recent = NOW.getTime() - 5 * 60_000;
    const dir = await root([
      snapshot([request({ timestamp: recent, responseTimestamp: recent })]),
    ]);

    const result = await new CopilotReader().read({ rootDir: dir, now: NOW });
    // Counting a live chat as `completed` would inflate `#4.2`'s completion
    // signal — the same trap `claude-code.ts` guards against.
    expect(result.sessions[0]!.outcome).toBe("in_progress");
  });

  it("treats an idle session ending in an error as abandoned", async () => {
    const dir = await root([
      snapshot([
        request(),
        request({
          requestId: "request_b",
          timestamp: T0 + 2000,
          result: { errorDetails: { code: "badRequest" }, metadata: {} },
        }),
      ]),
    ]);

    const result = await new CopilotReader().read({ rootDir: dir, now: NOW });
    expect(result.sessions[0]!.outcome).toBe("abandoned");
  });

  it("treats an idle session that ended cleanly as completed", async () => {
    const result = await new CopilotReader().read({
      rootDir: await root([snapshot([request()])]),
      now: NOW,
    });
    expect(result.sessions[0]!.outcome).toBe("completed");
  });

  it("honours the lookback window", async () => {
    const dir = await root([
      snapshot([
        request({ requestId: "old", timestamp: T0 - 10 * 24 * 3600_000 }),
        request({ requestId: "new", timestamp: T0 }),
      ]),
    ]);

    const result = await new CopilotReader().read({
      rootDir: dir,
      since: new Date(T0 - 3600_000),
      now: NOW,
    });
    expect(result.calls.map((c) => c.messageId)).toEqual(["new"]);
  });

  it("survives a missing root without throwing", async () => {
    const result = await new CopilotReader().read({
      rootDir: join(tmpdir(), "usurp-copilot-does-not-exist"),
      now: NOW,
    });
    expect(result.calls).toEqual([]);
    expect(result.sessions).toEqual([]);
  });

  it("does not detect an absent editor", async () => {
    const reader = new CopilotReader({ roots: [join(tmpdir(), "usurp-nope")] });
    expect(await reader.detect()).toBe(false);
  });
});

describe("defaultRoots", () => {
  it("covers each platform's application-support layout", () => {
    expect(defaultRoots("/Users/x", "darwin")[0]).toBe(
      "/Users/x/Library/Application Support/Code/User/workspaceStorage",
    );
    // Linux uses XDG config, not application support.
    const linux = defaultRoots("/home/x", "linux");
    expect(linux.some((p) => p.includes("/.config/Code/User/workspaceStorage"))).toBe(true);
    // Insiders and the forks share the layout, so a competitor on any of them
    // still counts.
    expect(defaultRoots("/Users/x", "darwin").length).toBeGreaterThan(1);
    expect(defaultRoots("/Users/x", "darwin").some((p) => p.includes("Code - Insiders"))).toBe(
      true,
    );
  });
});
