import { spawnSync } from "node:child_process";
// Never silently fall back to ad-hoc or unsigned public installers.
if (!process.env.CSC_LINK && !process.env.CSC_NAME) throw new Error("A code-signing identity is required for a release. Use npm run pack for local testing only.");
if (process.platform === "darwin" && !(
  (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID) ||
  (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
)) throw new Error("Apple notarization credentials are required for a macOS release.");
const env = { ...process.env, CONNECT_SIGNED_RELEASE: "1" };
for (const [command, args] of [[process.execPath, ["build.mjs"]], [process.execPath, ["node_modules/electron-builder/cli.js", "--publish", "never", "--config.forceCodeSigning=true"]]]) {
  const result = spawnSync(command, args, { env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
