/**
 * Codex rollout reader.
 *
 * Codex records one JSON object per line under `~/.codex/sessions/YYYY/MM/DD`.
 * `event_msg/token_count` is a *snapshot*: `total_token_usage` is cumulative,
 * while `last_token_usage` is the completed turn. Count the latter once per
 * event or a growing session would be charged repeatedly on every turn.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ApiCall, ReadOptions, ReaderResult, SessionRecord, UsageReader } from "./types.js";

export const AGENT_ID = "codex";
export const SESSION_IDLE_MS = 30 * 60 * 1000;

interface Row {
  timestamp?: string;
  type?: string;
  payload?: {
    cwd?: string;
    id?: string;
    session_id?: string;
    model?: string;
    model_provider?: string;
    type?: string;
    info?: {
      total_token_usage?: Record<string, number>;
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        cache_write_input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export class CodexReader implements UsageReader {
  readonly id = AGENT_ID;
  constructor(private readonly sessionsDir = join(homedir(), ".codex", "sessions"),
    private readonly archiveDir: string | undefined = sessionsDir === join(homedir(), ".codex", "sessions") ? join(homedir(), ".codex", "archived_sessions") : undefined) {}

  async detect(options?: ReadOptions): Promise<boolean> {
    for (const dir of this.roots(options)) { try { if ((await stat(dir)).isDirectory()) return true; } catch {} }
    return false;
  }

  private roots(options?: ReadOptions): string[] {
    return options?.rootDir ? [options.rootDir] : [this.sessionsDir, ...(this.archiveDir ? [this.archiveDir] : [])];
  }

  async read(options: ReadOptions = {}): Promise<ReaderResult> {
    const result: ReaderResult = { calls: [], edits: [], sessions: [], warnings: [] };
    const since = options.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const now = options.now ?? new Date();
    let files: string[] = [];
    for (const root of this.roots(options)) {
      try { files.push(...await this.files(root)); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push("skipped Codex data directory: read failed"); }
    }
    for (const file of files) {
      try {
        if (since !== Number.NEGATIVE_INFINITY && (await stat(file)).mtimeMs < since) continue;
        await this.file(file, since, now, result);
      } catch { result.warnings.push(`skipped Codex rollout: ${file}`); }
    }
    // A rollout can briefly exist in both locations while being archived.
    result.calls = [...new Map(result.calls.map(call => [call.messageId, call])).values()];
    result.sessions = [...new Map(result.sessions.map(session => [session.sessionId, session])).values()];
    return result;
  }

  private async files(dir: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (path: string): Promise<void> => {
      for (const e of await readdir(path, { withFileTypes: true })) {
        const next = join(path, e.name);
        if (e.isDirectory()) await visit(next);
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(next);
      }
    };
    await visit(dir); return out.sort();
  }

  private async file(file: string, since: number, now: Date, result: ReaderResult): Promise<void> {
    let id = "", cwd = "", model = "codex", first = "", last = "";
    let n = 0, startModel = model, lastSnapshot = "";
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      n++;
      let row: Row; try { row = JSON.parse(line) as Row; } catch { continue; }
      const timestamp = row.timestamp;
      if (!timestamp || !Number.isFinite(Date.parse(timestamp))) continue;
      // `turn_context` records (rather than the session header) carry the
      // selected model in current Codex rollouts. Keep it as rolling context
      // so each completed token-count event is attributed to the real model.
      model = row.payload?.model ?? model;
      if (row.type === "session_meta") {
        id = row.payload?.id ?? row.payload?.session_id ?? id;
        cwd = row.payload?.cwd ?? cwd;
      }
      if (row.type !== "event_msg" || row.payload?.type !== "token_count") continue;
      const usage = row.payload.info?.last_token_usage; if (!usage) continue;
      // Notifications can repeat the previous usage without a new completion.
      // Cumulative counters distinguish two genuine calls with identical usage.
      const total = row.payload.info?.total_token_usage;
      const snapshot = JSON.stringify(total
        ? Object.entries(total).sort(([a], [b]) => a.localeCompare(b))
        : [usage.input_tokens, usage.cached_input_tokens, usage.output_tokens, usage.cache_write_input_tokens]);
      if (snapshot === lastSnapshot) continue;
      lastSnapshot = snapshot;
      if (amount(usage.input_tokens) + amount(usage.output_tokens) + amount(usage.cached_input_tokens) + amount(usage.cache_write_input_tokens) === 0) continue;
      if (Date.parse(timestamp) < since) continue;
      if (!first) { first = timestamp; startModel = model; }
      last = timestamp;
      result.calls.push({
        messageId: `${id || file}:${n}`, timestamp, agent: this.id, model,
        // Codex input includes the cached portion. The wire format does not.
        inputTokens: Math.max(0, amount(usage.input_tokens) - amount(usage.cached_input_tokens)), outputTokens: amount(usage.output_tokens),
        cacheWrite5mTokens: amount(usage.cache_write_input_tokens), cacheWrite1hTokens: 0,
        cacheReadTokens: amount(usage.cached_input_tokens), sessionId: id || file, cwd,
      });
    }
    if (!first || !last) return;
    result.sessions.push({ sessionId: id || file, agent: this.id, cwd, startedAt: first, endedAt: last,
      startModel, endModel: model, outcome: now.getTime() - Date.parse(last) > SESSION_IDLE_MS ? "completed" : "in_progress" });
  }
}
