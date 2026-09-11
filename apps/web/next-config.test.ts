import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configUrl = new URL("./next.config.mjs", import.meta.url);
describe("production configuration startup", () => {
  for (const qa of ["0", "1"]) it(`loads with plain Node without a compiler (QA=${qa})`, () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e",
      `const {default: config} = await import(${JSON.stringify(configUrl.href)}); console.log(JSON.stringify(config));`],
      { env: { ...process.env, USURP_QA: qa }, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({
      distDir: qa === "1" ? ".next-qa" : ".next",
      serverExternalPackages: ["postgres"],
      typescript: { ignoreBuildErrors: false },
    });
  });
  it("ships the native ESM configuration in the runtime image", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8");
    expect(dockerfile).toContain("COPY --from=build /app/apps/web/next.config.mjs ./apps/web/");
    expect(dockerfile).not.toContain("next.config.ts");
  });
});
