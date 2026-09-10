import { afterEach, describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { postWebhook, publicAddress } from "./webhook-http.js";

afterEach(() => vi.unstubAllEnvs());
describe("webhook egress", () => {
  it("rejects special, mapped, private, loopback and metadata IP ranges", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.100.100.200",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "fe80::1",
      "fd00::1",
      "2001:db8::1",
      "2002:7f00:1::",
    ])
      expect(publicAddress(address), address).toBe(false);
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
      expect(publicAddress(address), address).toBe(true);
  });
  it("blocks literal private production destinations before connecting", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const target of [
      "https://127.0.0.1/",
      "https://[::ffff:7f00:1]/",
      "http://example.com",
      "https://user:pass@example.com/",
    ])
      await expect(postWebhook(target, {}, "{}", 1000)).rejects.toThrow();
  });
  it("delivers to an explicit development receiver without following redirects", async () => {
    vi.stubEnv("NODE_ENV", "test");
    let calls = 0;
    const server = createServer((request, response) => {
      calls++;
      response.writeHead(302, { location: "http://169.254.169.254/" });
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("No test port");
      expect(
        await postWebhook(`http://localhost:${address.port}`, {}, "{}", 2000),
      ).toBe(302);
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
