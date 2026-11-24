import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const env = parseEnv(readFileSync(".env.local", "utf8"));
const origin = new URL(env.USURP_BASE_URL).origin;
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname));
assert.equal((await fetch(`${origin}/api/health`)).status, 200);
assert.match(await (await fetch(`${origin}/signin`)).text(), /Open local dashboard/);
const login = (password, source = origin) => fetch(`${origin}/auth/local`, {
  method: "POST", redirect: "manual", headers: { origin: source, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
});
assert.equal((await login(env.USURP_LOCAL_PASSWORD, "https://untrusted.example")).status, 403);
const wrong = await login("wrong-password");
assert.equal(wrong.status, 303);
assert.ok(wrong.headers.get("location").includes("error=local_password"));
assert.equal(wrong.headers.get("set-cookie"), null);
const good = await login(env.USURP_LOCAL_PASSWORD);
assert.equal(good.status, 303);
const cookie = good.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie?.startsWith("usurp_session="));
const me = await fetch(`${origin}/v1/me`, { headers: { cookie } });
assert.equal(me.status, 200);
assert.equal((await fetch(`${origin}/settings`, { headers: { cookie } })).status, 200);
assert.equal((await fetch(`${origin}/v1/me`)).status, 401);
assert.equal((await fetch(`${origin}/auth/github`, { redirect: "manual" })).status, 404);
await fetch(`${origin}/auth/signout`, { method: "POST", headers: { cookie, origin }, redirect: "manual" });
assert.equal((await fetch(`${origin}/v1/me`, { headers: { cookie } })).status, 401);
const again = await login(env.USURP_LOCAL_PASSWORD);
assert.equal(again.status, 303);
const againCookie = again.headers.get("set-cookie")?.split(";")[0];
assert.ok(againCookie);
await fetch(`${origin}/auth/signout`, { method: "POST", headers: { cookie: againCookie, origin }, redirect: "manual" });
console.log("Local health, offline owner login, session revocation, private settings, wrong-password and cross-origin checks passed. No credentials printed.");
