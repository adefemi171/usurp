import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { maintenanceServer } from "./maintenance.mjs";
import { runDemo } from "./render-demo.mjs";
it("blocks every application route and method but keeps the health probe live", async () => {
  const server = await maintenanceServer({ port: "0", host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const path of ["/", "/settings", "/auth/github/callback?code=test", "/v1/ingest", "/v1/pairings", "/api/usage/refresh"]) {
      for (const method of ["GET", "POST"]) { const r = await fetch(origin + path, { method }); expect(r.status).toBe(503); expect(r.headers.get("retry-after")).toBe("60"); }
    }
    expect(await (await fetch(origin + "/api/health")).json()).toEqual({ok:true,maintenance:true});
    expect((await fetch(origin + "/api/health",{method:"POST"})).status).toBe(503);
  } finally { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
});
it("maintenance never spawns migrations, web, or workers", async()=>{
  const runtime=Object.assign(new EventEmitter(),{env:{PORT:"10000",USURP_MAINTENANCE:"1"},execPath:process.execPath});
  const spawnProcess=vi.fn();const close=vi.fn((cb:Function)=>cb());const serveMaintenance=vi.fn(async()=>({closeAllConnections:vi.fn(),close}));
  const done=runDemo({runtime,spawnProcess,serveMaintenance});await Promise.resolve();runtime.emit("SIGTERM");expect(await done).toBe(0);expect(spawnProcess).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
});

it.each([true, false])("preflight success=%s keeps all application processes stopped", async success => {
  const runtime = Object.assign(new EventEmitter(), {
    env: { PORT: "10000", USURP_MAINTENANCE: "1", USURP_DB_PREFLIGHT_HOST: "db.example.test" },
    execPath: process.execPath,
  });
  const spawnProcess = vi.fn();
  const probeEndpoint = vi.fn(async () => {
    if (!success) throw new Error("Unreachable");
    return { ok: true, protocol: "TLSv1.3" };
  });
  const serveMaintenance = vi.fn(async () => ({ closeAllConnections: vi.fn(), close: (cb: Function) => cb() }));
  const done = runDemo({ runtime, spawnProcess, serveMaintenance, probeEndpoint });
  await vi.waitFor(() => expect(runtime.listenerCount("SIGTERM")).toBe(1));
  expect(probeEndpoint).toHaveBeenCalledWith({ host: "db.example.test", port: 15433 });
  expect(serveMaintenance).toHaveBeenCalledOnce();
  expect(spawnProcess).not.toHaveBeenCalled();
  runtime.emit("SIGTERM");
  expect(await done).toBe(0);
});
