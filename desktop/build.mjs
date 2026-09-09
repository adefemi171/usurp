import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
await mkdir(join(here, "dist"), { recursive: true });
await build({
  absWorkingDir: here, entryPoints: ["src/main.ts", "src/preload.ts", "src/sync-worker.ts"],
  outdir: "dist", outExtension: { ".js": ".cjs" }, platform: "node", target: "node22", format: "cjs", bundle: true,
  external: ["electron", "electron-updater", "@napi-rs/keyring"],
  define: { CONNECT_SIGNED_RELEASE: JSON.stringify(process.env.CONNECT_SIGNED_RELEASE === "1") },
  alias: { "@usurp/protocol": join(here, "../packages/protocol/src/index.ts"), "@usurp/readers": join(here, "../packages/readers/src/index.ts") },
});
for (const name of ["index.html", "renderer.js", "style.css"]) await copyFile(join(here, "src", name), join(here, "dist", name));
