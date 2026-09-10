import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  getDb,
  closeDb,
  users,
  arenas,
  dailyScores,
  ensureCurrentSeason,
  recomputeStandings,
  startOfUtcDay,
} from "@usurp/db";
import { eq, inArray } from "drizzle-orm";

// This writes synthetic fixtures and removes them. Refuse non-test databases
// and non-loopback servers before making any mutation or starting the app.
const database = new URL(process.env.DATABASE_URL ?? "");
assert(
  ["localhost", "127.0.0.1"].includes(database.hostname) &&
    /_test(?:_|$)/.test(database.pathname),
  "A local test database is required",
);
const base = new URL(process.env.USURP_QA_URL || "http://localhost:3002");
assert(
  base.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(base.hostname),
  "QA URL must be loopback",
);
const child = process.env.USURP_QA_URL
  ? null
  : spawn(process.execPath, ["scripts/web.mjs", "dev"], {
      stdio: "ignore",
      env: {
        ...process.env,
        USURP_QA: "1",
        USURP_DEV_AUTH: "1",
        PORT: base.port,
        USURP_BASE_URL: base.origin,
        AUTH_SECRET: randomBytes(32).toString("hex"),
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
        RESEND_API_KEY: "",
        AUTH_EMAIL_FROM: "",
      },
    });
const db = getDb(),
  handles = [],
  arenaIds = [];

function client() {
  const cookies = new Map();
  return async (path, method = "GET", body, origin = base.origin) => {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
      headers: {
        origin,
        "content-type": "application/json",
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";", 1)[0];
      const i = pair.indexOf("=");
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return response;
  };
}
async function login(handle) {
  handles.push(handle);
  const call = client();
  const start = await call("/auth/dev");
  assert(
    [302, 307].includes(start.status),
    "Development login must be enabled only on QA",
  );
  const state = new URL(start.headers.get("location"), base).searchParams.get(
    "state",
  );
  assert(state);
  const callback = await call(
    `/auth/dev/callback?${new URLSearchParams({ state, code: handle })}`,
  );
  assert([302, 307].includes(callback.status));
  assert.equal((await call("/v1/me")).status, 200);
  return call;
}
async function json(response, status = 200) {
  assert.equal(response.status, status, `Unexpected HTTP ${response.status}`);
  return response.json();
}

try {
  let health;
  for (let i = 0; i < 60; i++) {
    try {
      health = await fetch(new URL("/api/health", base), {
        signal: AbortSignal.timeout(2000),
      });
      if (health.ok) break;
    } catch {}
    await delay(500);
  }
  assert(health?.ok, "QA server did not start");
  assert.equal(
    health.headers.get("x-usurp-qa-database"),
    database.pathname.slice(1),
    "Refusing to test a server on a different database",
  );
  const aName = `http_a_${randomUUID().slice(0, 8)}`,
    bName = `http_b_${randomUUID().slice(0, 8)}`;
  const a = await login(aName),
    b = await login(bName),
    visitor = client();
  const club = await json(
    await a("/v1/arenas", "POST", { name: "HTTP smoke club" }),
    201,
  );
  arenaIds.push(club.id);
  await json(
    await b("/v1/arenas/join", "POST", { invite_code: club.invite_code }),
  );
  for (const path of [
    `/a/${club.slug}`,
    `/v1/arenas/${club.slug}/board`,
    `/v1/arenas/${club.slug}/feed`,
    `/v1/arenas/${club.slug}/stream`,
    `/v1/users/${aName}`,
  ])
    assert.equal((await visitor(path)).status, 404, path);
  assert.equal((await a(`/v1/arenas/${club.slug}/board`)).status, 200);
  const people = await db
    .select()
    .from(users)
    .where(inArray(users.handle, [aName, bName]));
  const now = new Date(),
    season = await ensureCurrentSeason(db, club.id, now);
  // A zero-point board already exists before the first successful sync.
  await recomputeStandings(db, club.id, season, now);
  await db
    .update(users)
    .set({ displayName: "Never Publish This Legal Name" })
    .where(inArray(users.handle, [aName, bName]));
  await db.insert(dailyScores).values(
    people.map((user) => ({
      userId: user.id,
      day: startOfUtcDay(now),
      volumePts: 500,
      efficiencyMultBp: 10000,
      streakMultBp: 10000,
      points: 500,
    })),
  );
  await recomputeStandings(db, club.id, season, now);
  for (const path of [
    `/v1/arenas/${club.slug}/board?metric=burn`,
    `/v1/arenas/${club.slug}/board?metric=rating`,
    `/u/${aName}?window=all`,
    `/a/${club.slug}?metric=rating`,
    "/v1/me",
    "/halls/longest-reign",
  ]) {
    const response = await a(path);
    assert.equal(response.status, 200, path);
    const body = await response.text();
    assert(
      !body.includes("Never Publish This Legal Name"),
      `Real name leaked in ${path}`,
    );
    if (path.includes("/a/")) {
      assert(
        body.includes("Sovereign"),
        "Two-member rating board needs a title",
      );
      assert(
        body.includes("has held the Throne"),
        "First scored sync must start a reign",
      );
    }
    if (path === "/halls/longest-reign") {
      assert(
        body.includes("HTTP smoke club"),
        "Reign must appear in the hall of fame",
      );
      assert(body.includes("reigning"));
    }
  }
  const challenge = {
    arena_id: club.id,
    opponent: bName,
    metric: "commits",
    wager_pts: 10,
    window: "24h",
  };
  assert.equal(
    (await a("/v1/duels", "POST", challenge, "https://untrusted.invalid"))
      .status,
    403,
  );
  const proposed = await json(await a("/v1/duels", "POST", challenge), 201);
  assert.equal(
    (await a(`/v1/duels/${proposed.duel.id}/accept`, "POST", {})).status,
    409,
  );
  const accepted = await json(
    await b(`/v1/duels/${proposed.duel.id}/accept`, "POST", {}),
  );
  assert.equal(accepted.duel.state, "accepted");
  assert.equal((await a("/settings")).status, 200);
  assert((await (await a("/settings")).text()).includes("Challenge a member"));
  const org = await json(
    await a("/v1/orgs", "POST", {
      name: "HTTP smoke organization",
      domain: `smoke-${randomUUID()}.example.com`,
      consent: true,
    }),
    201,
  );
  arenaIds.push(org.arena.id);
  assert.equal((await b(`/v1/orgs/${org.arena.id}/aggregate`)).status, 404);
  assert.equal(
    (await a(`/v1/orgs/${org.arena.id}/verify`, "POST", {})).status,
    409,
  );
  await json(await a(`/v1/orgs/${org.arena.id}/challenge`, "POST", {}));
  assert.equal(
    (await a("/v1/me", "DELETE", { confirmation: "wrong" })).status,
    400,
  );
  await json(await a("/v1/me", "DELETE", { confirmation: aName }));
  assert.equal((await a("/v1/me")).status, 401);
  await json(await b("/v1/me", "DELETE", { confirmation: bName }));
  assert.equal(
    (await db.select().from(users).where(inArray(users.handle, handles)))
      .length,
    0,
  );
  console.log(
    "PASS: real HTTP sign-in, handle-only identity, two-member titles, first-sync reign and hall, private routes, duels, CSRF, org ownership, and account deletion",
  );
} finally {
  if (arenaIds.length)
    await db.delete(arenas).where(inArray(arenas.id, arenaIds));
  if (handles.length)
    await db.delete(users).where(inArray(users.handle, handles));
  await closeDb();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}
