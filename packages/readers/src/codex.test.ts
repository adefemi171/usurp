import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexReader } from "./codex.js";
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true }); });
it("separates cached input and deduplicates snapshots before date filtering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usurp-codex-")); dirs.push(dir);
  const usage = { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 10 };
  const event = (minute: string, total: number) => ({ timestamp: `2026-09-09T10:${minute}:00Z`, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: { total_tokens: total } } } });
  await writeFile(join(dir, "rollout.jsonl"), [
    { timestamp: "2026-09-09T10:00:00Z", type: "session_meta", payload: { id: "test" } },
    { timestamp: "2026-09-09T10:00:00Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    event("01", 1010), event("02", 1010), event("03", 2020),
  ].map(JSON.stringify).join("\n"));
  const reader = new CodexReader(dir);
  const all = await reader.read();
  expect(all.calls).toHaveLength(2);
  expect(all.calls[0]).toMatchObject({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 });
  const recent = await reader.read({ since: new Date("2026-09-09T10:02:00Z") });
  expect(recent.calls).toEqual([all.calls[1]]);
  // Reading a rollout in both the active and archived directories counts once.
  const archived = await new CodexReader(dir, dir).read();
  expect(archived.calls).toEqual(all.calls);
  expect(archived.sessions).toEqual(all.sessions);
});
