/**
 * The `UsageReader` interface — `SPEC.md#3.1`.
 *
 * The spec requires the reader choice stay reversible (vendor AgentsView's
 * readers, or fall back to ccusage-style parsing), so nothing outside this
 * package may know how a transcript is laid out. Readers emit these neutral
 * records; `bucket.ts` turns them into wire buckets.
 *
 * Note what these records still carry that a bucket must not: `cwd`,
 * `sessionId`, and absolute file paths. Those are load-bearing locally — `cwd`
 * to count commits, `sessionId` to derive session outcomes — and are dropped by
 * the bucketing step. `#10.1` is a published commitment, so the boundary at
 * `toBuckets()` is the one place that guarantee is enforced.
 */

/**
 * One billed API call.
 *
 * The unit is the assistant *message*, not the transcript line. Claude Code
 * writes one line per content block and repeats `message.usage` verbatim on
 * every one, so summing lines inflates tokens by ~2.5x. `messageId` is the
 * dedupe key that prevents that.
 */
export interface ApiCall {
  /** `message.id` — the API's own billing unit, and our dedupe key. */
  messageId: string;
  /** ISO 8601 timestamp of the call. */
  timestamp: string;
  /** Which tool produced this, e.g. `claude-code`. */
  agent: string;
  /** Raw model id as written by the agent; normalized later. */
  model: string;

  inputTokens: number;
  outputTokens: number;
  /** Cache writes at the default 5-minute TTL (1.25x input rate). */
  cacheWrite5mTokens: number;
  /** Cache writes at the 1-hour TTL (2x input rate). */
  cacheWrite1hTokens: number;
  cacheReadTokens: number;

  /** Local-only. Used to group sessions; never transmitted. */
  sessionId: string;
  /** Local-only. Used to count commits; never transmitted. */
  cwd: string;
}

/** An edit tool invocation and whether it stuck. */
export interface EditEvent {
  timestamp: string;
  agent: string;
  /** Model of the assistant message that requested the edit. */
  model: string;
  sessionId: string;
  cwd: string;
  /**
   * True when the edit was applied, false when it was rejected or errored.
   *
   * `#4.2` uses `edits_reverted` to punish thrash. A transcript records a
   * user's *denial* of an edit and a failed edit, but not a later `git
   * checkout`, so this measures "edit that did not stick at the time" rather
   * than true reverts. Documented in the README as a known approximation.
   */
  applied: boolean;
}

/** A session's lifecycle, derived from its transcript. */
export interface SessionRecord {
  sessionId: string;
  agent: string;
  cwd: string;
  /** ISO timestamp of the session's first call. */
  startedAt: string;
  /** ISO timestamp of the session's last activity. */
  endedAt: string;
  /** Model of the session's first call — attributes `sessions_started`. */
  startModel: string;
  /** Model of the session's last call — attributes the terminal count. */
  endModel: string;
  /**
   * How the session ended, or `in_progress` when it is still live.
   *
   * An in-progress session contributes a `sessions_started` but no terminal
   * count, so a running session is never mistaken for a completed one.
   */
  outcome: "completed" | "abandoned" | "in_progress";
}

export interface ReaderResult {
  calls: ApiCall[];
  edits: EditEvent[];
  sessions: SessionRecord[];
  /** Non-fatal problems: an unparseable line, an unreadable file. */
  warnings: string[];
}

export interface ReadOptions {
  /**
   * Ignore activity older than this. `usurp sync` passes a lookback window
   * rather than a strict cursor so that a re-read repairs a partially observed
   * hour; the server's upsert makes that idempotent.
   */
  since?: Date;
  /** Server clock, injected for deterministic tests. */
  now?: Date;
  /** Override the agent's data directory. Primarily for tests. */
  rootDir?: string;
}

export interface UsageReader {
  /** Stable agent identifier, used as `bucket.agent`. */
  readonly id: string;
  /** Whether this agent's data directory exists on this machine. */
  detect(options?: ReadOptions): Promise<boolean>;
  /** Read local session data. Must never throw for a malformed transcript. */
  read(options?: ReadOptions): Promise<ReaderResult>;
}
