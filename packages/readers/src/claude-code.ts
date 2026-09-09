/**
 * Claude Code transcript reader — `SPEC.md#3.1`, v1 source.
 *
 * Reads `~/.claude/projects/<slug>/<session-id>.jsonl`. Each file is one
 * session; each line is a JSON record.
 *
 * ── The double-counting trap ────────────────────────────────────────────────
 * Claude Code writes one `assistant` line per *content block* — a `thinking`
 * block, a `text` block, and each `tool_use` block all get their own line — and
 * repeats `message.usage` verbatim on every one of them. Measured on a real
 * transcript, one API call appeared as up to 4 lines, all carrying the same
 * 31,974 cache-read tokens.
 *
 * Summing lines therefore overstates usage by roughly 2.5x. Since the Burn
 * board ranks on exactly these numbers, that is not a rounding error — it is a
 * fabricated leaderboard. We key on `message.id`, the API's own billing unit,
 * and take each message's usage once.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type {
  ApiCall,
  EditEvent,
  ReadOptions,
  ReaderResult,
  SessionRecord,
  UsageReader,
} from "./types.js";

export const AGENT_ID = "claude-code";

/** Tools whose successful use counts as an applied edit. */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * A session with no activity for this long is treated as terminal. `usurp sync`
 * normally runs from a `SessionEnd` hook, so the session that triggered it is
 * genuinely finished — but other transcripts on the machine may still be live,
 * and counting a running session as `completed` would inflate `#4.2`'s
 * `completion` signal.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Cap on retained warnings, so a single corrupt file cannot exhaust memory. */
const MAX_WARNINGS = 50;

/** Text Claude Code writes into the transcript when a turn is interrupted. */
const INTERRUPTED = /\[Request interrupted/i;

/** Text a tool_result carries when the user declines a tool call. */
const DENIED = /doesn't want to proceed|rejected|user denied/i;

/**
 * Model names that are not billable API calls.
 *
 * Claude Code writes `<synthetic>` for messages it generates locally — an
 * interrupt notice, an error placeholder — and they carry a `message.id` and a
 * `usage` block like any other assistant line. Counted, they would appear on
 * the board as an `unknown_model` bucket, flagged by `#3.4`'s gates, priced at
 * zero, and polluting the per-model breakdown with a model nobody ran.
 *
 * Matched by shape (angle brackets) rather than by exact string, because the
 * convention is clearly a placeholder marker and other names may follow.
 */
const SYNTHETIC_MODEL = /^<.*>$/;

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface ContentBlock {
  type?: string;
  name?: string;
  id?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    usage?: UsageBlock;
    content?: ContentBlock[] | string;
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** A pending edit, awaiting its `tool_result` to know whether it stuck. */
interface PendingEdit {
  toolUseId: string;
  timestamp: string;
  model: string;
  sessionId: string;
  cwd: string;
}

export interface ClaudeCodeReaderOptions {
  /** Defaults to `~/.claude/projects`. */
  projectsDir?: string;
}

export class ClaudeCodeReader implements UsageReader {
  readonly id = AGENT_ID;

  constructor(private readonly options: ClaudeCodeReaderOptions = {}) {}

  private projectsDir(options?: ReadOptions): string {
    return (
      options?.rootDir ?? this.options.projectsDir ?? join(homedir(), ".claude", "projects")
    );
  }

  async detect(options?: ReadOptions): Promise<boolean> {
    try {
      return (await stat(this.projectsDir(options))).isDirectory();
    } catch {
      return false;
    }
  }

  async read(options: ReadOptions = {}): Promise<ReaderResult> {
    const now = options.now ?? new Date();
    const sinceMs = options.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const result: ReaderResult = { calls: [], edits: [], sessions: [], warnings: [] };

    let files: string[];
    try {
      files = await this.listTranscripts(this.projectsDir(options));
    } catch (err) {
      // A missing directory is normal on a machine without Claude Code.
      warn(result, `cannot list ${this.projectsDir(options)}: ${message(err)}`);
      return result;
    }

    for (const file of files) {
      try {
        // Skip files untouched since the lookback window. Cheap, and the only
        // reason a full re-read stays fast as history accumulates.
        if (sinceMs !== Number.NEGATIVE_INFINITY) {
          const info = await stat(file);
          if (info.mtimeMs < sinceMs) continue;
        }
        await this.readTranscript(file, sinceMs, now, result);
      } catch (err) {
        // One unreadable transcript must not lose the whole sync.
        warn(result, `skipped ${file}: ${message(err)}`);
      }
    }

    return result;
  }

  /** `<projectsDir>/<slug>/<session>.jsonl` — one level of nesting. */
  private async listTranscripts(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDir = join(dir, entry.name);
      let inner;
      try {
        inner = await readdir(projectDir, { withFileTypes: true });
      } catch {
        continue; // Unreadable project directory; nothing to do.
      }
      for (const file of inner) {
        if (file.isFile() && file.name.endsWith(".jsonl")) {
          out.push(join(projectDir, file.name));
        }
      }
    }
    return out.sort();
  }

  private async readTranscript(
    file: string,
    sinceMs: number,
    now: Date,
    result: ReaderResult,
  ): Promise<void> {
    /** message.id -> already counted. The fix for the double-counting trap. */
    const seenMessages = new Set<string>();
    const pendingEdits = new Map<string, PendingEdit>();
    /** tool_use_id -> whether the edit stuck. */
    const editOutcomes = new Map<string, boolean>();

    let sessionId = "";
    let cwd = "";
    let firstTs = "";
    let lastTs = "";
    let firstModel = "";
    let lastModel = "";
    let interrupted = false;
    let badLines = 0;

    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const raw of lines) {
        const text = raw.trim();
        if (!text) continue;

        let line: TranscriptLine;
        try {
          line = JSON.parse(text) as TranscriptLine;
        } catch {
          badLines++;
          continue;
        }

        // A transcript is appended to while being written, so a torn final
        // line is expected rather than exceptional.
        if (line.sessionId) sessionId = line.sessionId;
        if (line.cwd) cwd = line.cwd;

        // Sidechain lines are subagent turns. They are billed to the same
        // account, so they count — but they carry their own session id, which
        // would otherwise inflate the session count.
        const ts = line.timestamp;

        if (line.type === "assistant") {
          const handled = this.handleAssistant(line, {
            file,
            sinceMs,
            seenMessages,
            pendingEdits,
            result,
          });
          if (ts && handled.counted) {
            if (!firstTs || ts < firstTs) {
              firstTs = ts;
              firstModel = handled.model;
            }
            if (!lastTs || ts > lastTs) {
              lastTs = ts;
              lastModel = handled.model;
            }
          }
        } else if (line.type === "user") {
          if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
          interrupted = this.handleUser(line, editOutcomes) || interrupted;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }

    if (badLines > 0) {
      warn(result, `${file}: skipped ${badLines} unparseable line(s)`);
    }

    // Resolve each edit against its tool_result. An edit with no result at all
    // (the transcript ends mid-call) is treated as not applied — we only claim
    // an edit stuck when the transcript says so.
    for (const edit of pendingEdits.values()) {
      result.edits.push({
        timestamp: edit.timestamp,
        agent: this.id,
        model: edit.model,
        sessionId: edit.sessionId || sessionId,
        cwd: edit.cwd || cwd,
        applied: editOutcomes.get(edit.toolUseId) ?? false,
      });
    }

    if (!sessionId || !firstTs) return; // Nothing billable in this transcript.

    const endedMs = Date.parse(lastTs || firstTs);
    const live = now.getTime() - endedMs < SESSION_IDLE_MS;

    const session: SessionRecord = {
      sessionId,
      agent: this.id,
      cwd,
      startedAt: firstTs,
      endedAt: lastTs || firstTs,
      startModel: firstModel,
      endModel: lastModel || firstModel,
      outcome: live ? "in_progress" : interrupted ? "abandoned" : "completed",
    };

    // A session that both started and ended before the window is irrelevant;
    // one that merely *started* before it may still book a terminal count.
    if (Date.parse(session.endedAt) >= sinceMs) {
      result.sessions.push(session);
    }
  }

  private handleAssistant(
    line: TranscriptLine,
    ctx: {
      file: string;
      sinceMs: number;
      seenMessages: Set<string>;
      pendingEdits: Map<string, PendingEdit>;
      result: ReaderResult;
    },
  ): { counted: boolean; model: string } {
    const msg = line.message;
    const model = msg?.model ?? "";
    const messageId = msg?.id;
    const ts = line.timestamp;
    if (!msg || !messageId || !ts || !model) return { counted: false, model };

    // Not a real call: skip before it can become a bucket. Edits inside a
    // synthetic message are skipped with it — there are none in practice, and
    // attributing an edit to a model that never ran would be worse.
    if (SYNTHETIC_MODEL.test(model)) return { counted: false, model };

    const blocks = Array.isArray(msg.content) ? msg.content : [];

    // Edit tool calls are per-block, so they are collected on every line —
    // unlike usage, which is per-message and collected once below.
    for (const block of blocks) {
      if (block?.type === "tool_use" && block.name && EDIT_TOOLS.has(block.name) && block.id) {
        ctx.pendingEdits.set(block.id, {
          toolUseId: block.id,
          timestamp: ts,
          model,
          sessionId: line.sessionId ?? "",
          cwd: line.cwd ?? "",
        });
      }
    }

    // ── The dedupe that matters. See the header comment. ──
    if (ctx.seenMessages.has(messageId)) return { counted: true, model };
    ctx.seenMessages.add(messageId);

    if (Date.parse(ts) < ctx.sinceMs) return { counted: false, model };

    const usage = msg.usage ?? {};
    const creation = usage.cache_creation;
    // Prefer the explicit TTL split when present — it is what makes accurate
    // cache-write pricing possible (1.25x vs 2x). Older transcripts only have
    // the total, which we attribute to the cheaper 5m tier rather than
    // overstating cost.
    const write5m = creation ? num(creation.ephemeral_5m_input_tokens) : 0;
    const write1h = creation ? num(creation.ephemeral_1h_input_tokens) : 0;
    const writeTotal = num(usage.cache_creation_input_tokens);
    const splitTotal = write5m + write1h;

    const call: ApiCall = {
      messageId,
      timestamp: ts,
      agent: this.id,
      model,
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheWrite5mTokens: splitTotal > 0 ? write5m : writeTotal,
      cacheWrite1hTokens: splitTotal > 0 ? write1h : 0,
      cacheReadTokens: num(usage.cache_read_input_tokens),
      sessionId: line.sessionId ?? "",
      cwd: line.cwd ?? "",
    };

    ctx.result.calls.push(call);
    return { counted: true, model };
  }

  /** Returns true when this line marks an interruption. */
  private handleUser(line: TranscriptLine, editOutcomes: Map<string, boolean>): boolean {
    const content = line.message?.content;

    if (typeof content === "string") return INTERRUPTED.test(content);
    if (!Array.isArray(content)) return false;

    let interrupted = false;
    for (const block of content) {
      if (!block) continue;
      if (block.type === "text" && block.text && INTERRUPTED.test(block.text)) {
        interrupted = true;
      }
      if (block.type === "tool_result" && block.tool_use_id) {
        const body = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        const failed = block.is_error === true || DENIED.test(body);
        editOutcomes.set(block.tool_use_id, !failed);
      }
    }
    return interrupted;
  }
}

function warn(result: ReaderResult, text: string): void {
  if (result.warnings.length < MAX_WARNINGS) result.warnings.push(text);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
