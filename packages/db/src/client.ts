/**
 * Database client.
 *
 * One pooled connection per process, created lazily. Next.js route handlers are
 * re-evaluated on every hot reload in dev, so a module-level connection built
 * eagerly leaks a pool per reload until Postgres refuses new clients.
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { databaseTransport } from "./transport.js";

export type Db = PostgresJsDatabase<typeof schema>;

let cached: { db: Db; sql: postgres.Sql } | undefined;

export function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d postgres`.",
    );
  }
  return url;
}

export function getDb(): Db {
  if (!cached) {
    const transport = databaseTransport();
    const sql = postgres(transport.connectionString, {
      ...(transport.ssl ? { ssl: transport.ssl } : {}),
      // The ingest path is short transactions from a `SessionEnd` hook, not
      // long-lived streaming, so a small pool is plenty and keeps a
      // self-hosted single-container Postgres comfortable.
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idle_timeout: 30,
      connect_timeout: 10,
      // Timestamps are compared and bucketed in UTC throughout; letting the
      // server's local zone leak in would shift hour boundaries.
      types: {},
      onnotice: () => {},
    });
    cached = { db: drizzle(sql, { schema }), sql };
  }
  return cached.db;
}

/** Raw handle, for advisory locks and migrations. */
export function getSql(): postgres.Sql {
  getDb();
  return cached!.sql;
}

/** Close the pool. For tests and one-shot scripts. */
export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = undefined;
  }
}

export { schema };
