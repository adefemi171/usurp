/** Native Cursor IDE metadata reader. No AgentsView service or login required.
 * Transcript tool arguments (fast/inherit/model) are NOT model attribution.
 * Never read ItemTable (credentials) or return composer bodies/encryption keys.
 */
import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { normalizeModelId } from "@usurp/protocol";
import type { ReadOptions, ReaderResult, UsageReader } from "./types.js";
import { cursorUsageExport } from "./cursor-usage.js";

export const AGENT_ID = "cursor";
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export function cursorDatabase(): string {
  const base = platform() === "darwin" ? join(homedir(), "Library", "Application Support")
    : platform() === "win32" ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

export function cursorModel(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || ["default", "auto", "inherit", "fast"].includes(raw)) return "cursor-auto-unknown";
  return normalizeModelId(raw);
}

export class CursorReader implements UsageReader {
  readonly id = AGENT_ID;
  constructor(private readonly database = cursorDatabase()) {}
  async detect(options?: ReadOptions): Promise<boolean> {
    if (process.env.USURP_CURSOR_USAGE_CSV) return true;
    try { return (await stat(options?.rootDir ?? this.database)).isFile(); } catch { return false; }
  }
  async read(options: ReadOptions = {}): Promise<ReaderResult> {
    const result: ReaderResult = { calls: [], edits: [], sessions: [], warnings: [] };
    let db: import("node:sqlite").DatabaseSync | undefined;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(options.rootDir ?? this.database, { readOnly: true });
      db.exec("PRAGMA busy_timeout=3000; BEGIN");
      // Nonempty conversations only; drafts and filesystem mtime aren't sessions.
      const rows = db.prepare(`SELECT key,
        json_extract(value, '$.createdAt') started,
        json_extract(value, '$.lastUpdatedAt') ended,
        json_extract(value, '$.modelConfig.modelName') model
        FROM cursorDiskKV WHERE key GLOB 'composerData:*' AND json_valid(value)
        AND json_array_length(json_extract(value, '$.fullConversationHeadersOnly')) > 0`).all();
      const since = options.since?.getTime() ?? -Infinity;
      for (const row of rows) {
        const start = typeof row.started === "number" ? row.started : NaN;
        const end = typeof row.ended === "number" ? Math.max(start, row.ended) : start;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < since) continue;
        const model = cursorModel(row.model);
        result.sessions.push({ sessionId: String(row.key), agent: this.id, cwd: "",
          startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(),
          startModel: model, endModel: model,
          // The selected model is conversation metadata, not a completed call.
          // Missing completion timestamps must not create scoring credit.
          outcome: "in_progress" });
      }
      // Some older IDE versions persist measured token counts. Most current
      // bubbles contain zero placeholders. Neither those nor context-window
      // estimates are billed calls. Only import positive counters with a real
      // event timestamp; never assign the conversation's current model to an
      // older turn whose actual model is missing.
      const measured = db.prepare(`SELECT key,
        json_extract(value, '$.tokenCount.inputTokens') input,
        json_extract(value, '$.tokenCount.outputTokens') output,
        json_extract(value, '$.modelInfo.modelName') model,
        json_extract(value, '$.createdAt') created,
        json_extract(value, '$.timingInfo.clientRpcSendTime') sent
        FROM cursorDiskKV WHERE key GLOB 'bubbleId:*' AND json_valid(value)
        AND json_extract(value, '$.type') = 2
        AND (json_extract(value, '$.tokenCount.inputTokens') > 0 OR json_extract(value, '$.tokenCount.outputTokens') > 0)`).all();
      let undated = 0;
      for (const row of measured) {
        const time = typeof row.created === "string" ? Date.parse(row.created) : typeof row.sent === "number" ? row.sent : NaN;
        if (!Number.isFinite(time)) { undated++; continue; }
        if (time < since) continue;
        const amount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
        result.calls.push({ messageId: String(row.key), sessionId: String(row.key).split(":")[1] ?? "", agent: this.id,
          model: cursorModel(row.model), timestamp: new Date(time).toISOString(), cwd: "",
          inputTokens: amount(row.input), outputTokens: amount(row.output), cacheReadTokens: 0,
          cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
      }
      db.exec("COMMIT");
      if (result.sessions.length) result.warnings.push(`Cursor: ${result.calls.length} timestamped token records and ${result.sessions.length} conversations. Other conversations have unavailable usage, not zero. Session models are selected-model metadata; missing per-call models remain unknown. Cache breakdown is not recorded.`);
      if (undated) result.warnings.push(`Cursor: ${undated} token records skipped because no reliable event timestamp was recorded.`);
    } catch {
      result.warnings.push("Cursor: could not read the native IDE database. Requires Node 22.13+ and access to Cursor's state.vscdb; no transcript model guesses were imported.");
    } finally { db?.close(); }
    const exportPath = process.env.USURP_CURSOR_USAGE_CSV;
    if (exportPath) {
      try {
        const exported = await cursorUsageExport(exportPath);
        if (!exported.length) throw new Error("No usage rows");
        const times = exported.map(c => Date.parse(c.timestamp));
        const from = Math.min(...times), to = Math.max(...times);
        // Prefer the billing export within its explicit timestamp coverage.
        result.calls = result.calls.filter(c => Date.parse(c.timestamp) < from || Date.parse(c.timestamp) > to);
        result.calls.push(...exported.filter(c => !options.since || Date.parse(c.timestamp) >= options.since.getTime()));
        result.warnings.push("Cursor: using the explicit usage CSV for its covered period. Costs are API-rate estimates; subscription charges are not substituted for model prices.");
      } catch {
        result.warnings.push("Cursor: could not read the usage CSV. Existing history must not be repaired until the export is valid. Required: timezone-qualified Date, Model, Input Tokens, Output Tokens, Cache Read; optional Cache Write.");
      }
    }
    return result;
  }
}
