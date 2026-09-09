import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://usurp:usurp@localhost:5432/usurp",
  },
  // Enum and index changes are easy to generate by accident; make every
  // migration something a human read before it ran.
  verbose: true,
  strict: true,
});
