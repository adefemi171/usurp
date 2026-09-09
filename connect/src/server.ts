import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Controller } from "./controller.js";
import { startupStatus, setStartup } from "./startup.js";

export async function serve(controller: Controller, requestedPort = 43127, entry = join(__dirname, "main.cjs")) {
  const token = randomBytes(32).toString("base64url");
  let origin = "", closing = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) { reply(403, { error: "Untrusted local request." }); return; }
    const url = new URL(req.url ?? "/", origin);
    const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html; charset=utf-8"], "/ui.js": ["ui.js", "text/javascript; charset=utf-8"], "/style.css": ["style.css", "text/css; charset=utf-8"] };
    if (req.method === "GET" && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      try { res.writeHead(200, { "content-type": type }); res.end(await readFile(join(__dirname, file))); } catch { res.end(); }
      return;
    }
    const auth = Buffer.from(String(req.headers.authorization ?? "")); const expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { reply(401, { error: "Open this control page using usurp-connect on your computer." }); return; }
    try {
      if (req.method === "GET" && url.pathname === "/api/state") { reply(200, { ...await controller.state(), startup: await startupStatus() }); return; }
      if (req.method !== "POST" || url.pathname !== "/api/action") { reply(404, { error: "Not found" }); return; }
      if (req.headers["content-type"] !== "application/json") { reply(415, { error: "JSON required" }); return; }
      let body = "";
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) { reply(413, { error: "Request too large" }); return; } }
      const value = JSON.parse(body);
      if (value.action === "stop") { reply(200, { ok: true }); setTimeout(() => void close(), 50); return; }
      if (value.action === "startup") {
        if (typeof value.enabled !== "boolean") throw new Error("Invalid startup preference.");
        await setStartup(value.enabled, controller.directory, entry, (server.address() as any).port);
      } else await controller.action(value.action, value.value);
      reply(200, { ok: true });
    } catch (e) { reply(400, { error: e instanceof Error ? e.message : "Operation failed." }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(requestedPort, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  await mkdir(controller.directory, { recursive: true, mode: 0o700 });
  const runtimePath = join(controller.directory, "runtime.json");
  await writeFile(runtimePath, JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
  const timer = setInterval(() => void controller.tick().catch(() => {}), 5500);
  async function close() {
    if (closing) return; closing = true; clearInterval(timer); controller.shutdown();
    await unlink(runtimePath).catch(() => {}); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
  return { origin, token, close };
}
