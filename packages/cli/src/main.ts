#!/usr/bin/env node
/**
 * `usurp` — CLI entrypoint.
 *
 * Hand-rolled argument parsing rather than a dependency. The surface is nine
 * flags across six commands, and `usurp sync` runs on every session end, so
 * every millisecond of module load and every transitive dependency is a cost
 * paid constantly for something the platform already does.
 */

import { login, logout } from "./commands/login.js";
import { preview } from "./commands/preview.js";
import { status } from "./commands/status.js";
import { sync } from "./commands/sync.js";
import { hookInstall, hookStatus, hookUninstall } from "./commands/hook.js";
import { bold, cyan, dim, error, info } from "./ui.js";

const VERSION = "0.1.0";

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

/** `--flag`, `--flag value`, `--flag=value`, `-h`. */
function parse(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  const valueFlags = new Set(["api", "label", "since", "agentsview"]);

  // Every token is classified in one pass, so a leading flag (`usurp
  // --version`) is a flag rather than being mistaken for the command name.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }

    const bare = arg.replace(/^--?/, "");
    const eq = bare.indexOf("=");
    if (eq !== -1) {
      flags.set(bare.slice(0, eq), bare.slice(eq + 1));
      continue;
    }

    // Only consume the next token for flags that actually take a value, so
    // `usurp sync --all` does not swallow a following subcommand.
    if (valueFlags.has(bare) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
      flags.set(bare, argv[++i]!);
    } else {
      flags.set(bare, true);
    }
  }

  // The first bare token is the command; the rest are its arguments.
  const command = positional.shift() ?? "help";
  return { command, positional, flags };
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function bool(flags: Map<string, string | true>, ...names: string[]): boolean {
  return names.some((name) => flags.get(name) !== undefined);
}

function usage(): void {
  info(`${bold("usurp")} ${dim(VERSION)} — sync your AI coding-agent usage to the league

${bold("USAGE")}
  usurp <command> [options]

${bold("COMMANDS")}
  ${cyan("login <code>")}      Enrol this machine. Generates a device key and stores it
                    in the OS keychain. Never writes the key to disk.
  ${cyan("sync")}              Read local agent data, sign it, and submit.
  ${cyan("preview")}           Print exactly what sync would send, without sending it.
  ${cyan("status")}            Check the config, the device key, and the server.
  ${cyan("hook <sub>")}        Manage the Claude Code SessionEnd hook.
                    Subcommands: install, uninstall, status
  ${cyan("logout")}            Forget this device and drop its key from the keychain.

${bold("OPTIONS")}
  --api <url>       Server to talk to (default: $USURP_API_URL or localhost:3000)
  --label <name>    Device label shown in the UI (default: hostname)
  --all             Import all history; activity older than 90 days is analytics-only
  --repair          (sync --all) atomically replace this device's Codex/Cursor
                    history, with a server-side aggregate backup
  --no-git          Skip commit counting entirely
  --agentsview <url> Prefer daily analytics from this local AgentsView bridge;
                    saved after a successful import. Native readers still run.
  --no-bridge       Skip the optional bridge for this sync
  --bridge-only     Refresh the saved bridge snapshot without reading local files
  --print-key       (login) print the device key to stdout instead of storing
                    it in the OS keychain. For headless Linux, containers, CI.
  --json            (preview) emit the signed payload as JSON
  --quiet           (sync) suppress success output
  --soft            (sync) exit 0 even on failure — used by the hook
  --version, -v     Print the version
  --help, -h        Print this help

${bold("PRIVACY")}
  Only aggregate hourly counters leave your machine: token counts, call counts,
  session and edit counts, a commit count, and a cost estimate. Never prompts,
  completions, code, file paths, repo names, branch names, cwd, session ids, or
  tool arguments. Run ${cyan("usurp preview")} to see the exact payload.

${bold("ENVIRONMENT")}
  USURP_API_URL     Default server URL
  USURP_DEVICE_KEY  Device private key as a PKCS#8 PEM. For containers and CI,
                    where no OS keychain exists. Takes precedence over the
                    keychain.
  USURP_CONFIG_DIR  Override ~/.usurp
  USURP_CURSOR_USAGE_CSV  Optional local Cursor usage export; see README
`);
}

async function main(): Promise<number> {
  const { command, positional, flags } = parse(process.argv.slice(2));

  // Checked before dispatch so `--version` and `--help` work with or without a
  // command, and short-circuit a command that would otherwise touch the network.
  if (bool(flags, "version", "v") || command === "version") {
    info(VERSION);
    return 0;
  }
  if (bool(flags, "help", "h") || command === "help") {
    usage();
    return 0;
  }

  const api = str(flags, "api");
  const label = str(flags, "label");
  const all = bool(flags, "all");
  const noGit = bool(flags, "no-git");

  switch (command) {
    case "login":
      return login({
        ...(positional[0] ? { code: positional[0] } : {}),
        ...(api ? { api } : {}),
        ...(label ? { label } : {}),
        ...(bool(flags, "print-key") ? { printKey: true } : {}),
      });

    case "logout":
      return logout();

    case "sync":
      return sync({
        ...(str(flags, "agentsview") ? { agentsview: str(flags, "agentsview")! } : {}),
        ...(bool(flags, "no-bridge") ? { noBridge: true } : {}),
        ...(bool(flags, "bridge-only") ? { bridgeOnly: true } : {}),
        ...(bool(flags, "repair") ? { repair: true } : {}),
        ...(api ? { api } : {}),
        ...(all ? { all } : {}),
        ...(noGit ? { noGit } : {}),
        ...(bool(flags, "quiet") ? { quiet: true } : {}),
        ...(bool(flags, "soft") ? { soft: true } : {}),
      });

    case "preview":
      return preview({
        ...(str(flags, "agentsview") ? { agentsview: str(flags, "agentsview")! } : {}),
        ...(bool(flags, "no-bridge") ? { noBridge: true } : {}),
        ...(bool(flags, "bridge-only") ? { bridgeOnly: true } : {}),
        ...(all ? { all } : {}),
        ...(noGit ? { noGit } : {}),
        ...(bool(flags, "json") ? { json: true } : {}),
      });

    case "status":
      return status();

    case "hook": {
      const sub = positional[0] ?? "status";
      if (sub === "install") return hookInstall();
      if (sub === "uninstall" || sub === "remove") return hookUninstall();
      if (sub === "status") return hookStatus();
      error(`unknown hook subcommand: ${sub}`, "Expected install, uninstall, or status.");
      return 2;
    }

    default:
      error(`unknown command: ${command}`, "Run `usurp --help`.");
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    // Last resort. A stack trace at the end of every coding session is how a
    // hook gets uninstalled, so print one line and let `--soft` decide the code.
    error(err instanceof Error ? err.message : String(err));
    if (process.env.USURP_DEBUG) console.error(err);
    process.exit(1);
  });
