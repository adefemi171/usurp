#!/usr/bin/env node
/**
 * Run the web app with the repo-root `.env` loaded.
 *
 * Next.js reads `.env` from its own project directory (`apps/web`), but the
 * root `.env` is what `docker compose` reads, and one file is better than two
 * that drift. This wrapper is invoked as
 *
 *   node --env-file-if-exists=.env scripts/web.mjs [dev|start|build]
 *
 * so Node populates `process.env` first and the Next child inherits it. In
 * Docker there is no `.env` at all — compose sets the variables directly — and
 * `--env-file-if-exists` makes that a no-op rather than an error.
 */

import { spawn } from "node:child_process";

const script = process.argv[2] ?? "dev";

if (!["dev", "start", "build"].includes(script)) {
  console.error(`usage: web.mjs [dev|start|build], got ${script}`);
  process.exit(2);
}

const child = spawn("npm", ["-w", "@usurp/web", "run", script], {
  stdio: "inherit",
  // No shell: nothing here is user input, and a shell would only add a layer
  // that swallows signals.
  shell: false,
});

// Forward signals so Ctrl-C stops Next rather than orphaning it.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
