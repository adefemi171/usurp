import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

// Dedicated disposable CI project. Never use a developer's .env or volumes.
if (process.env.CI !== "true")
  throw new Error("This disposable smoke test is CI-only.");
const env = {
  ...process.env,
  POSTGRES_USER: "usurp",
  POSTGRES_DB: "usurp_ci_smoke",
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  AUTH_SECRET: randomBytes(32).toString("hex"),
  POSTGRES_PORT: "55434",
  WEB_PORT: "3001",
  USURP_BASE_URL: "http://localhost:3001",
  DATABASE_URL_OVERRIDE: "",
  DATABASE_SSL_MODE: "",
  DATABASE_CA_CERT: "",
  RESEND_API_KEY: "",
  AUTH_EMAIL_FROM: "",
  GITHUB_CLIENT_ID: "",
  GITHUB_CLIENT_SECRET: "",
  USURP_AGENTS_VIEW_URL: "",
  USURP_AGENTS_VIEW_DEVICE_ID: "",
};
const args = [
  "compose",
  "--env-file",
  "/dev/null",
  "--project-name",
  "usurp-ci-smoke",
];
function docker(extra) {
  const result = spawnSync("docker", [...args, ...extra], {
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("Docker smoke command failed");
}
try {
  docker(["up", "--build", "--detach", "--wait", "--wait-timeout", "180"]);
  for (const path of ["/api/health", "/signin", "/privacy"]) {
    const response = await fetch(`http://127.0.0.1:3001${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Smoke check failed: ${path} (${response.status})`);
  }
} catch (error) {
  docker(["logs", "--tail", "100", "web", "worker", "migrate"]);
  throw error;
} finally {
  docker(["down", "--volumes", "--remove-orphans"]);
}
