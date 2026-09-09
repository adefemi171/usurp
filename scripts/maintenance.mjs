import { createServer } from "node:http";

/** Maintenance replaces the whole application, not just its UI. No database
 * connection, migration, worker, OAuth callback or upload handler is started. */
export async function maintenanceServer({ port = process.env.PORT || "3000", host = "0.0.0.0" } = {}) {
  const server = createServer((req, res) => {
    const health = req.method === "GET" && req.url === "/api/health";
    res.writeHead(health ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store", ...(health ? {} : { "retry-after": "60" }) });
    res.end(JSON.stringify(health ? { ok: true, maintenance: true } : { error: "maintenance", message: "Usurp is temporarily paused for database maintenance. Please retry shortly." }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(port), host, resolve); });
  return server;
}
