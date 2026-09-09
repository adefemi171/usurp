/**
 * Commit counting — `SPEC.md#3.3`.
 *
 * The spec's privacy contract permits exactly one thing from git: a *count* of
 * the local user's commits in a window. No repo identity, no branch, no
 * messages, no SHAs. `#4.2` needs it for the `yield` signal (commits per
 * effective token), which is what punishes burn-without-output.
 *
 * `git` is invoked with an argument array and no shell, so a repository path or
 * a configured author string containing shell metacharacters is inert.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Give up rather than stall a `SessionEnd` hook on a huge or wedged repo. */
const GIT_TIMEOUT_MS = 5_000;

/** A commit count is a small integer; anything larger means we misread. */
const MAX_OUTPUT_BYTES = 1024;

export interface CommitCounter {
  /**
   * Commits authored by the local user in `cwd` within `[start, end)`.
   * Returns 0 for anything that is not a readable git repository.
   */
  count(cwd: string, start: Date, end: Date): Promise<number>;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      // Keep the subprocess from prompting for credentials or reading a pager.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    });
    return stdout.trim();
  } catch {
    // Not a repo, git missing, timeout, detached worktree — all mean "no
    // count", never a failed sync.
    return undefined;
  }
}

export class GitCommitCounter implements CommitCounter {
  /** cwd -> author email, or null when it cannot be determined. */
  private readonly authorCache = new Map<string, string | null>();

  private async author(cwd: string): Promise<string | null> {
    const cached = this.authorCache.get(cwd);
    if (cached !== undefined) return cached;

    const email = await git(cwd, ["config", "--get", "user.email"]);
    const value = email && email.length > 0 ? email : null;
    this.authorCache.set(cwd, value);
    return value;
  }

  async count(cwd: string, start: Date, end: Date): Promise<number> {
    const author = await this.author(cwd);
    // Without an author we would be counting the whole team's commits, which
    // both overstates the user's yield and leaks nothing useful. Skip.
    if (!author) return 0;

    const out = await git(cwd, [
      "rev-list",
      "--count",
      `--author=${author}`,
      `--since=${start.toISOString()}`,
      `--until=${end.toISOString()}`,
      "HEAD",
    ]);
    if (out === undefined) return 0;

    const n = Number.parseInt(out, 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }
}

/** A counter that always returns 0 — for tests and for `--no-git`. */
export class NullCommitCounter implements CommitCounter {
  async count(): Promise<number> {
    return 0;
  }
}
