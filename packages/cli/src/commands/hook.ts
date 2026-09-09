/**
 * `usurp hook install` / `uninstall` — the zero-friction ingestion trigger
 * from `SPEC.md#3.2`.
 *
 * Registers a `SessionEnd` hook in `~/.claude/settings.json` that runs
 * `usurp sync`. No daemon, no cron, no background service — the agent tells us
 * when a session ended, which is exactly when there is something new to read.
 *
 * Three details that matter for not being uninstalled by an annoyed user:
 *
 *   - `args` exec form, so the command never goes through a shell. A home
 *     directory containing a space, a quote, or a `$` is inert.
 *   - absolute interpreter + script path, so the hook does not depend on
 *     `usurp` being on the `PATH` of whatever shell Claude Code launched from.
 *   - `--soft`, so a failed leaderboard sync exits 0. A hook that reports
 *     failure at the end of every session reads as *the session* failing.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bold, cyan, dim, error, info, success, warn } from "../ui.js";

/** Marks our entry so install is idempotent and uninstall is surgical. */
const MARKER = "usurp-sync";

/**
 * Long enough for a slow network (the API client's own timeout is 15s), short
 * enough that a wedged sync does not visibly hang the end of a session.
 */
const HOOK_TIMEOUT_SECONDS = 25;

interface CommandHook {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  statusMessage?: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export function claudeSettingsPath(): string {
  return process.env.USURP_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

/** Absolute path to this CLI's entrypoint (`dist/main.js`). */
function cliEntrypoint(): string {
  // `import.meta.url` is this module inside `dist/commands/`, so the binary is
  // one level up. Resolved rather than assumed so a symlinked install works.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "main.js");
}

function ourHook(): CommandHook {
  return {
    type: "command",
    // Exec form: no shell, so paths with spaces or metacharacters are safe.
    command: process.execPath,
    args: [cliEntrypoint(), "sync", "--quiet", "--soft"],
    timeout: HOOK_TIMEOUT_SECONDS,
    statusMessage: "Syncing usurp…",
    // Our marker. Unknown keys are preserved by Claude Code's schema.
    [MARKER]: true,
  };
}

function isOurs(hook: CommandHook): boolean {
  if (hook[MARKER] === true) return true;
  // Also catch hooks written before the marker existed, or by hand.
  const haystack = [hook.command, ...(hook.args ?? [])].join(" ");
  return /usurp/i.test(haystack) && /\bsync\b/.test(haystack);
}

async function readSettings(path: string): Promise<Settings> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings.json does not contain a JSON object");
    }
    return parsed as Settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Never overwrite a file we could not parse. A malformed settings.json
    // silently disables *every* setting in it, so clobbering one would break
    // far more than this hook.
    throw new Error(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function hookInstall(): Promise<number> {
  const path = claudeSettingsPath();

  let settings: Settings;
  try {
    settings = await readSettings(path);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err), "Fix the JSON, then retry.");
    return 1;
  }

  // Merge, never replace: this file holds the user's theme, permissions, and
  // every other hook they rely on.
  const hooks = settings.hooks ?? {};
  const groups = [...(hooks.SessionEnd ?? [])];

  let replaced = false;
  const nextGroups: HookGroup[] = groups.map((group) => {
    const kept = (group.hooks ?? []).filter((h) => !isOurs(h));
    if (kept.length !== (group.hooks ?? []).length) replaced = true;
    return { ...group, hooks: kept };
  });

  // `SessionEnd` has no tool to match on, so the group carries no `matcher`.
  const target = nextGroups.find((g) => g.matcher === undefined);
  if (target) {
    target.hooks.push(ourHook());
  } else {
    nextGroups.push({ hooks: [ourHook()] });
  }

  settings.hooks = {
    ...hooks,
    SessionEnd: nextGroups.filter((g) => g.hooks.length > 0),
  };

  try {
    await writeSettings(path, settings);
  } catch (err) {
    error(`cannot write ${path}`, err instanceof Error ? err.message : String(err));
    return 1;
  }

  success(replaced ? "updated the SessionEnd hook" : "installed a SessionEnd hook");
  info("");
  info(`  ${dim("file")}  ${path}`);
  info(`  ${dim("runs")}  ${cyan("usurp sync --quiet --soft")} when a session ends`);
  info("");
  info(
    dim("  Claude Code only watches settings files that existed at startup, so open"),
  );
  info(dim(`  ${bold("/hooks")} once (or restart) for this to take effect in a running session.`));
  info("");
  return 0;
}

export async function hookUninstall(): Promise<number> {
  const path = claudeSettingsPath();

  let settings: Settings;
  try {
    settings = await readSettings(path);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const groups = settings.hooks?.SessionEnd;
  if (!groups || groups.length === 0) {
    warn("no SessionEnd hooks are configured");
    return 0;
  }

  let removed = 0;
  const nextGroups = groups
    .map((group) => {
      const kept = (group.hooks ?? []).filter((h) => {
        const ours = isOurs(h);
        if (ours) removed++;
        return !ours;
      });
      return { ...group, hooks: kept };
    })
    .filter((group) => group.hooks.length > 0);

  if (removed === 0) {
    warn("no usurp hook found");
    return 0;
  }

  const nextHooks = { ...settings.hooks };
  if (nextGroups.length > 0) {
    nextHooks.SessionEnd = nextGroups;
  } else {
    // Leave no empty `SessionEnd: []` behind.
    delete nextHooks.SessionEnd;
  }
  settings.hooks = nextHooks;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  try {
    await writeSettings(path, settings);
  } catch (err) {
    error(`cannot write ${path}`, err instanceof Error ? err.message : String(err));
    return 1;
  }

  success(`removed ${removed} usurp hook${removed === 1 ? "" : "s"} from ${path}`);
  return 0;
}

/** `usurp hook status` — is the hook actually installed? */
export async function hookStatus(): Promise<number> {
  const path = claudeSettingsPath();

  let settings: Settings;
  try {
    settings = await readSettings(path);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const ours = (settings.hooks?.SessionEnd ?? [])
    .flatMap((g) => g.hooks ?? [])
    .filter(isOurs);

  if (ours.length === 0) {
    info(`no usurp SessionEnd hook in ${dim(path)}`);
    info(`  ${dim("install it with")} ${cyan("usurp hook install")}`);
    return 1;
  }

  success(`usurp SessionEnd hook installed in ${path}`);
  for (const hook of ours) {
    info(`  ${dim([hook.command, ...(hook.args ?? [])].join(" "))}`);
  }
  return 0;
}
