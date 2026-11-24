import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { initializeEnv } from "./init-env.mjs";

const command = process.argv[2];
if (command === "setup") {
  try { initializeEnv(process.cwd(), ".env.local"); console.log("Created private .env.local. Use its USURP_LOCAL_PASSWORD at http://localhost:3000/signin. Existing .env was not changed."); }
  catch (e) { console.error(e.code === "EEXIST" ? ".env.local exists; left unchanged." : "Local setup failed; check permissions and the environment template."); process.exitCode = 1; }
} else if (["up", "start", "stop", "status"].includes(command)) {
  const values = parseEnv(readFileSync(".env.local", "utf8"));
  const url = new URL(values.USURP_BASE_URL);
  if (values.USURP_LOCAL_ONLY !== "1" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || values.DATABASE_URL_OVERRIDE || (values.USURP_LOCAL_PASSWORD?.length ?? 0) < 32)
    throw new Error("Use a local-only .env.local with a generated owner password and no remote database override.");
  // Do not inherit old cloud credentials or Compose variable overrides.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(USURP_|DATABASE_|POSTGRES_|AUTH_|GITHUB_CLIENT_|GOOGLE_CLIENT_|RESEND_|WEB_PORT|COMPOSE_)/.test(k)));
  const actions = { up: ["up", "--build", "-d", "--wait", "--wait-timeout", "180"], start: ["up", "--no-build", "--pull", "never", "-d", "--wait", "--wait-timeout", "180"], stop: ["stop"], status: ["ps"] };
  const result = spawnSync("docker", ["compose", "--env-file", ".env.local", "--project-name", "usurp-local", ...actions[command]], { env: { ...env, ...values }, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} else { console.error("Usage: node scripts/local.mjs setup|up|start|stop|status"); process.exitCode = 2; }
