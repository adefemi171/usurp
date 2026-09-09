import { describe, expect, it } from "vitest";
import { deepLinkServer, serverOrigin, sourceSelection } from "./policy.js";
describe("companion trust boundaries", () => {
  it("accepts secure deployment origins and explicit loopback development", () => {
    expect(serverOrigin("https://usurp.onrender.com/")).toBe("https://usurp.onrender.com");
    expect(serverOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
  it("rejects unsafe protocols, embedded credentials, paths and plaintext remote hosts", () => {
    for (const value of ["file:///tmp/x", "javascript:alert(1)", "http://evil.test", "https://user:pass@host.test", "https://host.test/path", "https://host.test?token=x"]) expect(() => serverOrigin(value)).toThrow();
  });
  it("deep links select an origin only, never authenticate or sync", () => {
    expect(deepLinkServer("usurp-connect://open?server=https%3A%2F%2Fusurp.onrender.com")).toBe("https://usurp.onrender.com");
    expect(() => deepLinkServer("usurp-connect://sync?server=https://example.com")).toThrow();
  });
  it("accepts only explicit built-in sources, including an empty consent list", () => {
    expect(sourceSelection([])).toEqual([]); expect(sourceSelection(["cursor", "codex"])).toEqual(["cursor", "codex"]);
    expect(() => sourceSelection(["unknown"])).toThrow(); expect(() => sourceSelection(["codex", "codex"])).toThrow();
  });
});
