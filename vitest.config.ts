import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/**
 * Load `.env` so integration tests can reach the compose database.
 *
 * Existing environment wins, so CI can override `DATABASE_URL` without editing
 * the file. Tests that need a database skip themselves when it is absent
 * (`describe.skipIf`), so a fresh clone with no Docker still runs green on the
 * unit suite.
 */
function loadEnv(): void {
  try {
    const text = readFileSync(fileURLToPath(new URL("./.env", import.meta.url)), "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = rawValue!.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env is fine.
  }
}

loadEnv();

export default defineConfig({
  resolve: {
    /**
     * Point workspace imports at TypeScript source rather than `dist`.
     *
     * Without this, a test exercises whatever was last compiled, so an edit
     * plus a forgotten `tsc -b` yields a green run against stale code. Type
     * errors are still caught — `npm run typecheck` builds the real graph.
     */
    alias: {
      "@usurp/protocol": src("protocol"),
      "@usurp/readers": src("readers"),
      "@usurp/db": src("db"),
      "@usurp/scoring": src("scoring"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/**/*.test.ts", "scripts/**/*.test.ts"],
    environment: "node",
    // Integration tests share one Postgres. Running files in parallel against
    // it makes truncation in one file wipe another's fixtures mid-assertion.
    fileParallelism: false,
  },
});
