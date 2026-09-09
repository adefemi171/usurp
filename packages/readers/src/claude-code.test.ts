import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeReader } from "./claude-code.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "usurp-cc-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a transcript at `<root>/<project>/<session>.jsonl`. */
async function transcript(
  project: string,
  session: string,
  lines: unknown[],
): Promise<void> {
  const dir = join(root, project);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${session}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

const SESSION = "52375a14-c4c4-4131-9a83-68f08242c2fc";
const CWD = "/Users/dev/project";

/**
 * An assistant line as Claude Code actually writes it: usage lives on the
 * message and is repeated on every content-block line.
 */
function assistantLine(opts: {
  messageId: string;
  timestamp: string;
  model?: string;
  content: unknown[];
  usage?: Record<string, unknown>;
}) {
  return {
    type: "assistant",
    timestamp: opts.timestamp,
    sessionId: SESSION,
    cwd: CWD,
    requestId: `req_${opts.messageId}`,
    message: {
      id: opts.messageId,
      type: "message",
      role: "assistant",
      model: opts.model ?? "claude-opus-5",
      content: opts.content,
      usage: opts.usage ?? {
        input_tokens: 2,
        output_tokens: 313,
        cache_creation_input_tokens: 4310,
        cache_read_input_tokens: 16857,
        cache_creation: {
          ephemeral_1h_input_tokens: 4310,
          ephemeral_5m_input_tokens: 0,
        },
      },
    },
  };
}

function userLine(content: unknown, timestamp: string) {
  return {
    type: "user",
    timestamp,
    sessionId: SESSION,
    cwd: CWD,
    message: { role: "user", content },
  };
}

// Well past SESSION_IDLE_MS after the fixtures, so sessions read as terminal.
const NOW = new Date("2026-09-08T20:00:00.000Z");

function read(reader = new ClaudeCodeReader()) {
  return reader.read({ rootDir: root, now: NOW });
}

describe("ClaudeCodeReader", () => {
  describe("the double-counting trap", () => {
    /**
     * The regression this reader exists to prevent. One API call, written as
     * four lines (thinking + text + two tool_use blocks), each repeating the
     * same `message.usage`. Naive line-summing yields 4x the real usage.
     */
    it("counts one call per message.id, not per transcript line", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [{ type: "thinking", thinking: "..." }],
        }),
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:01.000Z",
          content: [{ type: "text", text: "..." }],
        }),
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:02.000Z",
          content: [{ type: "tool_use", name: "Bash", id: "t1" }],
        }),
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:03.000Z",
          content: [{ type: "tool_use", name: "Bash", id: "t2" }],
        }),
      ]);

      const { calls } = await read();

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        messageId: "msg_A",
        inputTokens: 2,
        outputTokens: 313,
        cacheReadTokens: 16857,
      });
    });

    it("keeps genuinely distinct messages", async () => {
      await transcript("proj", SESSION, [
        assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
        assistantLine({ messageId: "msg_B", timestamp: "2026-09-08T13:11:00.000Z", content: [] }),
      ]);

      const { calls } = await read();
      expect(calls.map((c) => c.messageId)).toEqual(["msg_A", "msg_B"]);
    });
  });

  describe("cache write TTL split", () => {
    it("uses the explicit 5m/1h split when present", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 5,
            cache_creation: {
              ephemeral_5m_input_tokens: 400,
              ephemeral_1h_input_tokens: 600,
            },
          },
        }),
      ]);

      const { calls } = await read();
      expect(calls[0]).toMatchObject({ cacheWrite5mTokens: 400, cacheWrite1hTokens: 600 });
    });

    it("attributes an unsplit total to the cheaper tier rather than overstating cost", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 1000,
            cache_read_input_tokens: 5,
          },
        }),
      ]);

      const { calls } = await read();
      expect(calls[0]).toMatchObject({ cacheWrite5mTokens: 1000, cacheWrite1hTokens: 0 });
    });
  });

  describe("edits", () => {
    it("counts an edit as applied when its tool_result succeeded", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [{ type: "tool_use", name: "Edit", id: "edit_1" }],
        }),
        userLine(
          [{ type: "tool_result", tool_use_id: "edit_1", content: "ok" }],
          "2026-09-08T13:10:05.000Z",
        ),
      ]);

      const { edits } = await read();
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ applied: true, model: "claude-opus-5" });
    });

    it("counts an errored edit as not applied", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [{ type: "tool_use", name: "Write", id: "edit_1" }],
        }),
        userLine(
          [{ type: "tool_result", tool_use_id: "edit_1", is_error: true, content: "boom" }],
          "2026-09-08T13:10:05.000Z",
        ),
      ]);

      const { edits } = await read();
      expect(edits[0]).toMatchObject({ applied: false });
    });

    it("counts a user-declined edit as not applied", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [{ type: "tool_use", name: "Edit", id: "edit_1" }],
        }),
        userLine(
          [
            {
              type: "tool_result",
              tool_use_id: "edit_1",
              content: "The user doesn't want to proceed with this tool use.",
            },
          ],
          "2026-09-08T13:10:05.000Z",
        ),
      ]);

      const { edits } = await read();
      expect(edits[0]).toMatchObject({ applied: false });
    });

    it("counts an edit with no tool_result as not applied", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [{ type: "tool_use", name: "Edit", id: "edit_1" }],
        }),
      ]);

      const { edits } = await read();
      expect(edits[0]).toMatchObject({ applied: false });
    });

    it("skips a <synthetic> model — a local message, not a billable call", async () => {
      // Claude Code writes these for interrupt notices and error placeholders.
      // Counted, they would show up as an `unknown_model` bucket on the board.
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_synthetic",
          timestamp: "2026-09-08T13:10:00.000Z",
          model: "<synthetic>",
          content: [{ type: "text", text: "[Request interrupted]" }],
        }),
        assistantLine({ messageId: "msg_real", timestamp: "2026-09-08T13:11:00.000Z", content: [] }),
      ]);

      const { calls } = await read();
      expect(calls.map((c) => c.model)).toEqual(["claude-opus-5"]);
    });

    it("ignores non-edit tools", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [
            { type: "tool_use", name: "Bash", id: "t1" },
            { type: "tool_use", name: "Read", id: "t2" },
            { type: "tool_use", name: "WebFetch", id: "t3" },
          ],
        }),
      ]);

      expect((await read()).edits).toHaveLength(0);
    });

    it("counts each edit block on a multi-block message separately", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [{ type: "tool_use", name: "Write", id: "e1" }],
        }),
        // Same message.id: usage is counted once, but both edits are real.
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:01.000Z",
          content: [{ type: "tool_use", name: "Write", id: "e2" }],
        }),
      ]);

      const { calls, edits } = await read();
      expect(calls).toHaveLength(1);
      expect(edits).toHaveLength(2);
    });
  });

  describe("session outcomes", () => {
    it("marks an uninterrupted finished session completed", async () => {
      await transcript("proj", SESSION, [
        assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
      ]);

      const { sessions } = await read();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        sessionId: SESSION,
        outcome: "completed",
        startedAt: "2026-09-08T13:10:00.000Z",
      });
    });

    it("marks an interrupted session abandoned", async () => {
      await transcript("proj", SESSION, [
        assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
        userLine(
          [{ type: "text", text: "[Request interrupted by user for tool use]" }],
          "2026-09-08T13:10:30.000Z",
        ),
      ]);

      expect((await read()).sessions[0]).toMatchObject({ outcome: "abandoned" });
    });

    it("marks a still-active session in_progress so it is not scored as completed", async () => {
      const justNow = new Date(NOW.getTime() - 60_000).toISOString();
      await transcript("proj", SESSION, [
        assistantLine({ messageId: "msg_A", timestamp: justNow, content: [] }),
      ]);

      expect((await read()).sessions[0]).toMatchObject({ outcome: "in_progress" });
    });

    it("records the first and last models for attribution", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          model: "claude-sonnet-5",
          content: [],
        }),
        assistantLine({
          messageId: "msg_B",
          timestamp: "2026-09-08T14:20:00.000Z",
          model: "claude-opus-5",
          content: [],
        }),
      ]);

      expect((await read()).sessions[0]).toMatchObject({
        startModel: "claude-sonnet-5",
        endModel: "claude-opus-5",
        startedAt: "2026-09-08T13:10:00.000Z",
        endedAt: "2026-09-08T14:20:00.000Z",
      });
    });
  });

  describe("robustness", () => {
    it("survives a torn final line, which is normal for a live transcript", async () => {
      const dir = join(root, "proj");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${SESSION}.jsonl`),
        JSON.stringify(
          assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
        ) + '\n{"type":"assist',
        "utf8",
      );

      const { calls, warnings } = await read();
      expect(calls).toHaveLength(1);
      expect(warnings.join(" ")).toMatch(/unparseable/);
    });

    it("ignores lines that are not assistant or user records", async () => {
      await transcript("proj", SESSION, [
        { type: "mode", mode: "default", sessionId: SESSION },
        { type: "ai-title", aiTitle: "some title", sessionId: SESSION },
        { type: "file-history-snapshot", snapshot: {}, messageId: "x" },
        { type: "system", subtype: "turn_duration", durationMs: 1200, sessionId: SESSION },
        assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
      ]);

      expect((await read()).calls).toHaveLength(1);
    });

    it("skips an assistant line with no usable message", async () => {
      await transcript("proj", SESSION, [
        { type: "assistant", timestamp: "2026-09-08T13:10:00.000Z", sessionId: SESSION },
        { type: "assistant", timestamp: "2026-09-08T13:10:00.000Z", message: {} },
        assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
      ]);

      expect((await read()).calls).toHaveLength(1);
    });

    it("treats absent or negative token counts as zero", async () => {
      await transcript("proj", SESSION, [
        assistantLine({
          messageId: "msg_A",
          timestamp: "2026-09-08T13:10:00.000Z",
          content: [],
          usage: { input_tokens: -5, output_tokens: null as unknown as number },
        }),
      ]);

      expect((await read()).calls[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    });

    it("returns empty, with a warning, when the directory does not exist", async () => {
      const reader = new ClaudeCodeReader();
      const result = await reader.read({ rootDir: join(root, "nope"), now: NOW });
      expect(result.calls).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it("reads across multiple projects and sessions", async () => {
      await transcript("proj-a", "session-1", [
        assistantLine({ messageId: "msg_A", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
      ]);
      await transcript("proj-b", "session-2", [
        {
          ...assistantLine({ messageId: "msg_B", timestamp: "2026-09-08T13:20:00.000Z", content: [] }),
          sessionId: "other-session",
        },
      ]);

      const { calls, sessions } = await read();
      expect(calls).toHaveLength(2);
      expect(sessions).toHaveLength(2);
    });

    it("ignores non-jsonl files", async () => {
      const dir = join(root, "proj");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "notes.md"), "not a transcript", "utf8");
      expect((await read()).calls).toEqual([]);
    });
  });

  describe("since window", () => {
    it("excludes calls older than the window", async () => {
      await transcript("proj", SESSION, [
        assistantLine({ messageId: "msg_old", timestamp: "2026-09-01T13:10:00.000Z", content: [] }),
        assistantLine({ messageId: "msg_new", timestamp: "2026-09-08T13:10:00.000Z", content: [] }),
      ]);

      const result = await new ClaudeCodeReader().read({
        rootDir: root,
        now: NOW,
        since: new Date("2026-09-08T00:00:00.000Z"),
      });

      expect(result.calls.map((c) => c.messageId)).toEqual(["msg_new"]);
    });
  });

  describe("detect", () => {
    it("is true when the projects directory exists", async () => {
      expect(await new ClaudeCodeReader().detect({ rootDir: root })).toBe(true);
    });

    it("is false when it does not", async () => {
      expect(await new ClaudeCodeReader().detect({ rootDir: join(root, "nope") })).toBe(false);
    });
  });
});
