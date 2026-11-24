import { describe, it, expect } from "vitest";
import { ApiClient } from "./api.js";
describe("local-only usage transport", () => {
  it("rejects hosted, credential-bearing and non-HTTP destinations before sending", () => {
    for (const url of ["https://usurp.onrender.com", "http://192.168.1.2:3000", "http://user:pass@localhost:3000", "file://localhost/a", "http://localhost:3000/path"])
      expect(() => new ApiClient(url)).toThrow("local-only");
    expect(() => new ApiClient("http://localhost:3000")).not.toThrow();
  });
});
