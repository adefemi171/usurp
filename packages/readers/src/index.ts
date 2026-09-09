export type {
  ApiCall,
  EditEvent,
  ReadOptions,
  ReaderResult,
  SessionRecord,
  UsageReader,
} from "./types.js";

export { AGENT_ID, ClaudeCodeReader, SESSION_IDLE_MS, type ClaudeCodeReaderOptions } from "./claude-code.js";
export { AGENT_ID as CODEX_AGENT_ID, CodexReader, SESSION_IDLE_MS as CODEX_SESSION_IDLE_MS } from "./codex.js";
export { AGENT_ID as CURSOR_AGENT_ID, CursorReader, SESSION_IDLE_MS as CURSOR_SESSION_IDLE_MS } from "./cursor.js";

export {
  AGENT_ID as COPILOT_AGENT_ID,
  CopilotReader,
  defaultRoots as copilotRoots,
  normalizeCopilotModel,
  replayJournal,
  type CopilotReaderOptions,
} from "./vscode-copilot.js";

export { GitCommitCounter, NullCommitCounter, type CommitCounter } from "./git.js";

export { hourEnd, hourOf, hourStart, toBuckets, type BucketOptions } from "./bucket.js";

import { ClaudeCodeReader } from "./claude-code.js";
import { CopilotReader } from "./vscode-copilot.js";
import { CodexReader } from "./codex.js";
import { CursorReader } from "./cursor.js";
import type { UsageReader } from "./types.js";

/**
 * Readers enabled by default.
 *
 * `#3.1` also lists Codex, with the rest arriving via AgentsView's readers.
 * Adding one means appending here — nothing downstream of `toBuckets()` knows
 * how many readers there are, and `bucket.ts` already keys every bucket by
 * `(hour, agent, model)` so two agents in the same hour do not collide.
 *
 * Ordering is not significant: buckets are sorted by `(hour, agent, model)`
 * before submission so a repeat run is byte-identical regardless.
 */
export function defaultReaders(): UsageReader[] {
  return [new ClaudeCodeReader(), new CodexReader(), new CursorReader(), new CopilotReader()];
}
