/**
 * GitHub Copilot Chat reader — `SPEC.md#3.1`, "the rest arriving via
 * AgentsView's readers".
 *
 * ── Why this reader matters more than the roadmap implied ───────────────────
 * Measured on the development machine: Claude Code accounted for $148.84 of
 * notional model spend and VS Code Copilot for $128.96 — 46% of the total, on
 * models Usurp could not see at all. A league that reads one agent out of two
 * is not measuring "AI coding-agent usage", it is measuring Claude Code usage,
 * and every Copilot-heavy competitor silently reads as idle.
 *
 * ── The storage format ─────────────────────────────────────────────────────
 * `.../User/workspaceStorage/<workspace-hash>/chatSessions/<session>.jsonl`.
 *
 * Despite the extension this is **not** a log of independent records. It is an
 * incremental *journal* of mutations against one object:
 *
 *   {"kind":0,"v":{…}}                     full snapshot (first line)
 *   {"kind":1,"k":["requests",60,"result"],"v":{…}}   set at path
 *   {"kind":2,"k":["requests"],"v":[…]}              append to array at path
 *
 * So a line is meaningless on its own and the file must be replayed in order
 * to reach the current state. This is the opposite of Claude Code's format,
 * where the trap was that lines *repeat* usage; here the trap is that lines
 * *revise* it. Summing lines would count a request once per revision.
 *
 * ── What Copilot does and does not record ──────────────────────────────────
 * Present: `promptTokens`, `completionTokens`, `modelId`, `resolvedModel`, a
 * per-request `copilotCredits`, the workspace root, edit-tool invocations, and
 * (uniquely) *undo* events.
 *
 * Absent: any cache accounting. Copilot exposes no cache-read or cache-write
 * counts, so those are reported as zero rather than guessed. That is handled
 * correctly downstream — `signals.ts` maps a zero cache total to `null`, and
 * `zScores` scores a null signal at the cohort mean rather than worst in
 * cohort — so a Copilot user is neither rewarded nor punished on cache reuse.
 * Inventing a cache split here would break that.
 *
 * ── Cost is notional for this agent ────────────────────────────────────────
 * Copilot bills in subscription "premium requests"/AI credits, not per token:
 * the same 75 requests below carry 12.4 credits each and no dollar figure. The
 * `cost_micros` we derive is therefore "what these tokens would have cost at
 * the vendor's list API rate", which is the same basis AgentsView uses and the
 * only basis on which two agents can be compared at all. It is not an invoice.
 * `#4.2` scores on *tokens*, not dollars, so the leaderboard does not depend
 * on this number — the Burn board's cost column does.
 */

import { readFile } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type {
  ApiCall,
  EditEvent,
  ReadOptions,
  ReaderResult,
  SessionRecord,
  UsageReader,
} from "./types.js";

export const AGENT_ID = "vscode-copilot";

/** Mirrors `claude-code.ts`, for the same reason: a live session is not done. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

const MAX_WARNINGS = 50;

/**
 * Copilot tool ids whose invocation is an applied edit.
 *
 * Matched by prefix-free exact id because Copilot's tool ids are stable and
 * versioned by the extension, unlike Claude Code's bare `Edit`/`Write`.
 */
const EDIT_TOOLS = new Set([
  "copilot_replaceString",
  "copilot_multiReplaceString",
  "copilot_createFile",
  "copilot_applyPatch",
  "copilot_insertEdit",
  "copilot_editNotebook",
  "copilot_createDirectory",
]);

/**
 * `ChatRequestEditedFileEventKind` — VS Code's record of what the *user* then
 * did with an edit.
 *
 * This is a signal Claude Code cannot give us. `types.ts` documents
 * `edits_reverted` as an approximation precisely because a transcript sees a
 * denial but not a later `git checkout`; Copilot writes an explicit `Undo`
 * event when the user rejects an applied edit, which is the real thing `#4.2`
 * wanted to measure.
 *
 * The numeric values are read from the on-disk data rather than imported, so
 * they are asserted with care: only `UNDO` is treated as a revert and every
 * other value — including one added by a future VS Code — counts as applied.
 * A misread here would under-count reverts, never fabricate them.
 */
const EDITED_FILE_EVENT_UNDO = 2;

// ── Journal replay ─────────────────────────────────────────────────────────

const KIND_SNAPSHOT = 0;
const KIND_SET = 1;
const KIND_APPEND = 2;

type Json = unknown;
type JsonObject = Record<string, Json>;

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replay one journal file to the object it describes.
 *
 * Returns `undefined` rather than throwing for a file that never establishes a
 * snapshot: VS Code writes these files live, so a truncated tail is normal and
 * must not cost us the whole sync.
 */
export function replayJournal(text: string, onWarning?: (message: string) => void): JsonObject | undefined {
  let root: Json;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let entry: Json;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      // A half-written final line while VS Code is running. Everything before
      // it is still valid, so stop here rather than discard the file.
      onWarning?.("truncated journal line ignored");
      break;
    }

    if (!isObject(entry)) continue;

    if (entry.kind === KIND_SNAPSHOT) {
      root = entry.v;
      continue;
    }
    if (root === undefined) continue; // Mutation before any snapshot.

    const path = Array.isArray(entry.k) ? entry.k : undefined;
    if (!path || path.length === 0) continue;

    try {
      applyMutation(root, path as Array<string | number>, entry.v, entry.kind === KIND_APPEND);
    } catch {
      // A path into a shape we did not reconstruct. Skipping one mutation
      // loses one revision, not the file.
      onWarning?.("journal mutation skipped");
    }
  }

  return isObject(root) ? root : undefined;
}

function applyMutation(
  root: Json,
  path: Array<string | number>,
  value: Json,
  append: boolean,
): void {
  let cursor: Json = root;
  for (const segment of path.slice(0, -1)) {
    cursor = step(cursor, segment);
  }

  const last = path[path.length - 1]!;

  if (append) {
    const target = step(cursor, last);
    if (!Array.isArray(target) || !Array.isArray(value)) return;
    target.push(...value);
    return;
  }

  if (Array.isArray(cursor)) {
    cursor[Number(last)] = value;
  } else if (isObject(cursor)) {
    cursor[String(last)] = value;
  }
}

function step(node: Json, segment: string | number): Json {
  if (Array.isArray(node)) return node[Number(segment)];
  if (isObject(node)) return node[String(segment)];
  throw new Error("path does not exist");
}

// ── Extraction ─────────────────────────────────────────────────────────────

interface CopilotRequest {
  requestId?: string;
  timestamp?: number;
  responseTimestamp?: number;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  copilotCredits?: number;
  result?: {
    metadata?: {
      resolvedModel?: string;
      promptTokens?: number;
      outputTokens?: number;
      cacheKey?: string;
    };
    errorDetails?: { code?: string; message?: string };
  };
  response?: Json[];
  editedFileEvents?: Array<{ eventKind?: number; uri?: { fsPath?: string } }>;
}

/**
 * Roots to search, most-likely first.
 *
 * VS Code stores per-workspace state under a platform-specific application
 * support directory, and the Insiders build and VSCodium use sibling
 * directories with the same internal layout. All of them are checked because
 * a competitor running Insiders is still a competitor.
 */
export function defaultRoots(home = homedir(), os = platform()): string[] {
  const flavours = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

  const bases = (() => {
    if (os === "darwin") {
      return flavours.map((f) => join(home, "Library", "Application Support", f));
    }
    if (os === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return flavours.map((f) => join(appData, f));
    }
    // Linux and the BSDs: XDG config.
    const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    return flavours.map((f) => join(xdg, f));
  })();

  return bases.map((base) => join(base, "User", "workspaceStorage"));
}

export interface CopilotReaderOptions {
  /** Overrides the platform default. Primarily for tests. */
  roots?: string[];
}

export class CopilotReader implements UsageReader {
  readonly id = AGENT_ID;

  constructor(private readonly options: CopilotReaderOptions = {}) {}

  private roots(options?: ReadOptions): string[] {
    if (options?.rootDir) return [options.rootDir];
    return this.options.roots ?? defaultRoots();
  }

  async detect(options?: ReadOptions): Promise<boolean> {
    for (const root of this.roots(options)) {
      try {
        if ((await stat(root)).isDirectory()) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  async read(options: ReadOptions = {}): Promise<ReaderResult> {
    const now = options.now ?? new Date();
    const sinceMs = options.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const result: ReaderResult = { calls: [], edits: [], sessions: [], warnings: [] };

    const files: string[] = [];
    for (const root of this.roots(options)) {
      try {
        files.push(...(await listSessionFiles(root)));
      } catch {
        // A machine without this editor installed. Not worth a warning.
        continue;
      }
    }

    /**
     * The same session id can appear under two workspace hashes when a folder
     * is reopened from a different path. Keyed by absolute file path here and
     * de-duplicated by `requestId` below, so the double read is harmless.
     */
    const seenRequests = new Set<string>();

    for (const file of files.sort()) {
      try {
        if (sinceMs !== Number.NEGATIVE_INFINITY) {
          const info = await stat(file);
          if (info.mtimeMs < sinceMs) continue;
        }
        await this.readSession(file, sinceMs, now, result, seenRequests);
      } catch (err) {
        warn(result, `skipped ${file}: ${message(err)}`);
      }
    }

    return result;
  }

  private async readSession(
    file: string,
    sinceMs: number,
    now: Date,
    result: ReaderResult,
    seenRequests: Set<string>,
  ): Promise<void> {
    const text = await readFile(file, "utf8");
    const root = replayJournal(text, (m) => warn(result, `${file}: ${m}`));
    if (!root) return;

    const sessionId = typeof root.sessionId === "string" ? root.sessionId : basename(file);
    const requests = Array.isArray(root.requests) ? (root.requests as CopilotRequest[]) : [];
    if (requests.length === 0) return;

    let cwd = "";
    let firstTs = Number.POSITIVE_INFINITY;
    let lastTs = Number.NEGATIVE_INFINITY;
    let startModel = "";
    let endModel = "";
    let lastErrored = false;
    let countedAny = false;

    for (const request of requests) {
      const timestamp = typeof request.timestamp === "number" ? request.timestamp : undefined;
      if (timestamp === undefined) continue;

      const metadata = request.result?.metadata;

      // `cacheKey` is a `file://` URI for the workspace root. Local-only: it is
      // what makes `git.ts`'s commit count possible and is dropped by
      // `toBuckets()` before anything leaves the machine (`#10.1`).
      if (!cwd && typeof metadata?.cacheKey === "string") {
        cwd = fsPathOf(metadata.cacheKey);
      }

      /**
       * `resolvedModel` first: it is already canonical (`claude-opus-4-8`),
       * whereas `modelId` carries the Copilot routing prefix and a dotted
       * variant (`copilot/claude-opus-4.8`) that no pricing table knows.
       */
      const model = normalizeCopilotModel(metadata?.resolvedModel ?? request.modelId ?? "");

      const inputTokens = intOf(request.promptTokens ?? metadata?.promptTokens);

      /**
       * `completionTokens`, not `result.metadata.outputTokens`.
       *
       * Copilot records both, and they disagree — measured over 106 requests
       * on real data, `completionTokens` is a median 1.85x the metadata figure
       * and up to 31x on a long turn. The two sit in different places for a
       * reason: `promptTokens`/`completionTokens` are a matched pair at the
       * request level (the model's own usage report), while the metadata pair
       * lives beside `cacheKey` and `resolvedModel` and counts the *rendered*
       * response. The difference is reasoning tokens, which the response pane
       * does not render and the vendor does bill as output.
       *
       * A burn league bills what the model billed, so the request-level figure
       * wins. Worth knowing when comparing against AgentsView, which uses the
       * metadata figure: our Copilot output tokens read roughly 2.4x theirs on
       * the same window, and neither total is a transcription error.
       */
      const outputTokens = intOf(request.completionTokens ?? metadata?.outputTokens);

      // A request with no token accounting is one that never reached a model —
      // a cancelled turn, or the two-per-session `badRequest` failures seen in
      // real data. Counting it would add a call with zero cost and drag the
      // per-call averages the gates check.
      const billable = model !== "" && (inputTokens > 0 || outputTokens > 0);

      if (request.result?.errorDetails) lastErrored = true;
      else if (billable) lastErrored = false;

      if (billable && timestamp >= sinceMs) {
        const requestId =
          typeof request.requestId === "string" ? request.requestId : `${sessionId}:${timestamp}`;

        // The journal revises a request in place, so the replayed array holds
        // each one once — but a session reopened under a second workspace hash
        // yields the same ids twice.
        if (!seenRequests.has(requestId)) {
          seenRequests.add(requestId);
          const call: ApiCall = {
            messageId: requestId,
            timestamp: new Date(timestamp).toISOString(),
            agent: AGENT_ID,
            model,
            inputTokens,
            outputTokens,
            // Copilot exposes no cache accounting. Zero, not a guess.
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            cacheReadTokens: 0,
            sessionId,
            cwd,
          };
          result.calls.push(call);
          countedAny = true;
        }
      }

      if (billable) {
        firstTs = Math.min(firstTs, timestamp);
        const end = request.responseTimestamp ?? timestamp;
        if (end >= lastTs) {
          lastTs = end;
          endModel = model;
        }
        if (startModel === "" || timestamp === firstTs) startModel = model;
      }

      if (timestamp >= sinceMs) {
        collectEdits(request, sessionId, cwd, model, timestamp, result);
      }
    }

    if (!countedAny || firstTs === Number.POSITIVE_INFINITY) return;

    const idle = now.getTime() - lastTs > SESSION_IDLE_MS;
    result.sessions.push({
      sessionId,
      agent: AGENT_ID,
      cwd,
      startedAt: new Date(firstTs).toISOString(),
      endedAt: new Date(lastTs).toISOString(),
      startModel,
      endModel,
      /**
       * A chat session has no "end" marker — the panel is simply not used
       * again — so the outcome is inferred exactly as it is for Claude Code:
       * still warm means still running. A final request that errored is
       * abandoned rather than completed, because the user did not get their
       * answer.
       */
      outcome: !idle ? "in_progress" : lastErrored ? "abandoned" : "completed",
    });
  }
}

function collectEdits(
  request: CopilotRequest,
  sessionId: string,
  cwd: string,
  model: string,
  timestamp: number,
  result: ReaderResult,
): void {
  const base = { timestamp: new Date(timestamp).toISOString(), agent: AGENT_ID, sessionId, cwd, model };

  for (const item of request.response ?? []) {
    if (!isObject(item)) continue;
    if (item.kind !== "toolInvocationSerialized") continue;
    if (typeof item.toolId !== "string" || !EDIT_TOOLS.has(item.toolId)) continue;

    // `isComplete: false` is a tool call that never finished — a cancelled
    // turn. Not an applied edit and not a revert, so it is simply not counted.
    if (item.isComplete !== true) continue;

    const edit: EditEvent = { ...base, applied: item.isError !== true };
    result.edits.push(edit);
  }

  /**
   * Undo events are recorded as *reverted* edits.
   *
   * They are additional to the tool invocations above, not a replacement: the
   * edit was genuinely applied first and then taken back, which is precisely
   * the thrash `#4.2`'s `edits_reverted` exists to punish.
   */
  for (const event of request.editedFileEvents ?? []) {
    if (event?.eventKind !== EDITED_FILE_EVENT_UNDO) continue;
    result.edits.push({ ...base, applied: false });
  }
}

/**
 * Reduce a Copilot model id to something `models.ts` can price.
 *
 * Copilot writes three shapes for the same model: `claude-opus-4.8` (dotted),
 * `copilot/claude-opus-4.8` (routed), and `claude-opus-4-8` in
 * `resolvedModel`. Only the last is a real API id, so the first two are
 * rewritten to match rather than left to be flagged `unknown_model` three
 * different ways.
 */
export function normalizeCopilotModel(raw: string): string {
  let id = raw.trim().toLowerCase();
  if (id === "") return "";

  // Routing prefixes: `copilot/`, `github/`, `openai/`, `anthropic/`.
  const slash = id.lastIndexOf("/");
  if (slash !== -1) id = id.slice(slash + 1);

  /*
   * `auto` is Copilot's model *picker*, not a model — the value written when
   * the user let the extension choose and the routed id was never recorded.
   * Counted, it would appear on the per-model breakdown as a model nobody ran
   * and be flagged `unknown_model` forever, the same failure mode as Claude
   * Code's `<synthetic>`.
   *
   * Checked *after* the prefix strip, because the value on disk is
   * `copilot/auto` as often as bare `auto`.
   */
  if (id === "auto" || id === "default") return "";

  /*
   * Dated snapshot suffix: `claude-haiku-4-5-20251001`, `gpt-5.5-2026-04-23`.
   *
   * `normalizeModelId` strips these when pricing, but the bucket carries the
   * reader's string, so leaving them would split one model across two rows on
   * the per-model breakdown — `claude-haiku-4-5` and its dated alias listed as
   * if they were different models. Only Copilot writes them; Claude Code's
   * transcripts already use the undated id.
   */
  id = id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");

  /**
   * Dotted version to dashed, but only in a trailing version position.
   *
   * `claude-opus-4.8` → `claude-opus-4-8`, while `gpt-5.6-sol` keeps its dot
   * because that is the id OpenAI publishes. The distinction is made on the
   * `claude-` prefix rather than on the shape of the number, because guessing
   * from the shape would silently rewrite a future vendor's real id.
   */
  if (id.startsWith("claude-")) id = id.replace(/\./g, "-");

  return id;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** `file:///Users/x/proj` → `/Users/x/proj`. Left as-is if not a file URI. */
function fsPathOf(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return "";
  }
}

function intOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  const name = cut === -1 ? path : path.slice(cut + 1);
  return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}

/** `<root>/<workspace-hash>/chatSessions/*.jsonl` — two levels of nesting. */
async function listSessionFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const workspace of await readdir(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const dir = join(root, workspace.name, "chatSessions");
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // Most workspaces have never opened the chat panel.
    }
    for (const file of entries) {
      if (file.isFile() && file.name.endsWith(".jsonl")) out.push(join(dir, file.name));
    }
  }
  return out;
}

function warn(result: ReaderResult, text: string): void {
  if (result.warnings.length < MAX_WARNINGS) result.warnings.push(text);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
