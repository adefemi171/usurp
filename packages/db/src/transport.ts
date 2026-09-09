/** Both postgres.js (web/migrations) and pg (pg-boss) must verify the same
 * remote identity. Strip URL SSL parameters in strict mode so pg's URL parser
 * cannot silently replace the explicit certificate-verification options. */
export function databaseTransport(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set.");
  if (!env.DATABASE_SSL_MODE) return { connectionString: raw };
  if (env.DATABASE_SSL_MODE !== "verify-full") throw new Error("DATABASE_SSL_MODE must be verify-full when explicitly configured.");
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database protocol.");
  for (const key of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
  return { connectionString: url.href, ssl: { rejectUnauthorized: true, servername: url.hostname, minVersion: "TLSv1.2" as const,
    ...(env.DATABASE_CA_CERT ? { ca: env.DATABASE_CA_CERT.replace(/\\n/g,"\n") } : {}) } };
}
