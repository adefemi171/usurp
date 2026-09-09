import { describe, expect, it } from "vitest";
import { databaseTransport } from "./transport.js";
describe("shared database TLS transport",()=>{
  it("preserves existing local/Render configuration unless strict TLS is enabled",()=>{expect(databaseTransport({DATABASE_URL:"postgres://localhost/usurp"})).toEqual({connectionString:"postgres://localhost/usurp"});});
  it("verifies chain and hostname for both database drivers",()=>{const config=databaseTransport({DATABASE_URL:"postgres://app@usurp.example:15433/usurp?sslmode=require",DATABASE_SSL_MODE:"verify-full"});expect(config.ssl).toEqual({rejectUnauthorized:true,servername:"usurp.example",minVersion:"TLSv1.2"});expect(config.connectionString).not.toContain("sslmode");});
  it("does not allow URL options to weaken explicit TLS verification",()=>{const config=databaseTransport({DATABASE_URL:"postgres://app@db.example/usurp?ssl=false&sslmode=disable&sslrootcert=other&application_name=usurp",DATABASE_SSL_MODE:"verify-full",DATABASE_CA_CERT:"test\\nCA"});expect(config.ssl?.rejectUnauthorized).toBe(true);expect(config.ssl?.ca).toBe("test\nCA");expect(config.connectionString).toContain("application_name=usurp");expect(config.connectionString).not.toContain("ssl");});
  it("rejects insecure explicit modes and invalid database protocols",()=>{expect(()=>databaseTransport({DATABASE_URL:"postgres://localhost/u",DATABASE_SSL_MODE:"require"})).toThrow("verify-full");expect(()=>databaseTransport({DATABASE_URL:"https://db.example/u",DATABASE_SSL_MODE:"verify-full"})).toThrow("protocol");});
});
