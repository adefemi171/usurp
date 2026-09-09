/** Free, single-instance demo only. Stops completely when Render sleeps it.
 * Migrate before serving; supervise web + worker together so a failed worker
 * cannot leave a healthy-looking app with stale standings. Paid deployments
 * should continue using separate web and worker services.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function runDemo({ spawnProcess = spawn, runtime = process } = {}) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const children = new Set();
  let stopping = false;
  let exitCode = 0;
  let finish;
  let forceTimer;
  const completed = new Promise(resolve => { finish = resolve; });
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill("SIGTERM");
    forceTimer = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 20000);
    forceTimer.unref();
    if (!children.size) finish();
  };
  const launch = (args) => {
    const child = spawnProcess(runtime.execPath, args, {
      cwd: root, stdio: "inherit", env: runtime.env,
    });
    children.add(child);
    const closed = new Promise(resolve => {
      child.once("error", () => stop(1));
      child.once("close", (code) => {
        children.delete(child);
        resolve(code);
        if (stopping && !children.size) finish();
      });
    });
    return closed;
  };
  const signal = () => stop(0);
  runtime.on("SIGTERM", signal);
  runtime.on("SIGINT", signal);
  try {
    const migration = await launch(["packages/db/dist/migrate.js"]);
    if (!stopping && migration !== 0) stop(1);
    if (!stopping) {
      const web = launch(["node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", runtime.env.PORT || "3000"]);
      const worker = launch(["packages/db/dist/worker.js", "--recompute-cron", "*/2 * * * *"]);
      // Unexpected exit (even code 0) of either service restarts the whole demo.
      web.then(() => stop(1));
      worker.then(() => stop(1));
    }
    await completed;
    return exitCode;
  } finally {
    clearTimeout(forceTimer);
    runtime.off("SIGTERM", signal);
    runtime.off("SIGINT", signal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDemo();
}
