import { describe, it, expect } from "vitest";
import { readJson, bodyError } from "./request";

describe("bounded request bodies", () => {
  it("allows an empty body only when explicitly requested", async () => {
    expect(
      await readJson(
        new Request("https://example.test", { method: "POST" }),
        1024,
        true,
      ),
    ).toEqual({});
    await expect(
      readJson(new Request("https://example.test", { method: "POST" })),
    ).rejects.toThrow("invalid_json");
  });
  it("parses JSON below the byte cap", async () => {
    expect(
      await readJson(
        new Request("https://example.test", {
          method: "POST",
          body: '{"ok":true}',
        }),
      ),
    ).toEqual({ ok: true });
  });
  it("rejects oversized chunked input even without Content-Length", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: '"' + "x".repeat(100) + '"',
    });
    await expect(readJson(request, 20)).rejects.toThrow("payload_too_large");
    expect(bodyError(new Error("payload_too_large")).status).toBe(413);
  });
  it("rejects invalid JSON", async () => {
    await expect(
      readJson(
        new Request("https://example.test", { method: "POST", body: "{" }),
      ),
    ).rejects.toThrow("invalid_json");
  });
});
