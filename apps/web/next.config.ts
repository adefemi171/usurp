import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep isolated browser QA from taking the user's active dev-server lock.
  distDir: process.env.USURP_QA === "1" ? ".next-qa" : ".next",
  // Deliberately NOT `output: "standalone"`. The same image also runs the
  // migrate and enroll jobs (`docker-compose.yml`), so it needs the real
  // workspace and `node_modules` anyway — a standalone bundle would be a
  // second, differently-shaped copy of the app to keep working.
  //
  // `postgres` opens real sockets and must not be bundled into the server
  // build; Next would otherwise try to trace and inline it.
  serverExternalPackages: ["postgres"],
  typescript: {
    // Types are also checked by `npm run typecheck` across the whole
    // workspace, but leaving this on means a broken build fails here too.
    ignoreBuildErrors: false,
  },
};

export default config;
