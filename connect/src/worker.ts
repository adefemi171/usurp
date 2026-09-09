import { sync } from "../../packages/cli/src/commands/sync.js";
import { loadConfig } from "../../packages/cli/src/config.js";
process.once("message", async (data: { agents: string[]; bridge: boolean; all: boolean }) => {
  let warnings = 0;
  try {
    const before = await loadConfig();
    const code = await sync({ agents: data.agents, noGit: true, noBridge: !data.bridge,
      ...(data.bridge ? { agentsview: "http://127.0.0.1:8080" } : {}), all: data.all, quiet: true, onWarning: () => { warnings++; } });
    const after = await loadConfig();
    process.send?.({ ok: code === 0, uploaded: after.seq > before.seq, batches: after.seq - before.seq, warnings });
  } catch { process.send?.({ ok: false, uploaded: false, warnings }); }
});
