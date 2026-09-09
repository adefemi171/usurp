import { sync } from "../../packages/cli/src/commands/sync.js";
process.parentPort!.on("message", async ({ data }: { data: { agents: string[]; bridge: boolean; all: boolean } }) => {
  let warnings = 0;
  try {
    const code = await sync({ agents: data.agents, noGit: true, noBridge: !data.bridge,
      ...(data.bridge ? { agentsview: "http://127.0.0.1:8080" } : {}), all: data.all, quiet: true,
      onWarning: () => { warnings++; } });
    process.parentPort!.postMessage({ ok: code === 0, warnings });
  } catch { process.parentPort!.postMessage({ ok: false, warnings, error: "Could not read or sync usage. Check the connection and your source permissions." }); }
});
