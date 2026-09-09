import { expect, it } from "vitest";
import { parseCursorUsage } from "./cursor-usage.js";
it("imports measured Cursor model/cache counts without treating Included as zero cost", () => {
  const result = parseCursorUsage('Date,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost\r\n2026-09-08T12:30:00Z,gpt-5.6-terra-medium,1500,1000,"10,000",100,Included\r\n');
  expect(result[0]).toMatchObject({ agent: "cursor", model: "gpt-5.6-terra", inputTokens: 1000, outputTokens: 100, cacheWrite5mTokens: 500, cacheReadTokens: 10000 });
  expect(result[0]).not.toHaveProperty("cost");
});
it("rejects malformed/missing counters and ambiguous timestamps", () => {
  expect(() => parseCursorUsage("Date,Model,Input Tokens,Output Tokens,Cache Read\n09/08/2026,gpt-5.6-terra,100,20,0")).toThrow("timezone");
  expect(() => parseCursorUsage("Date,Model\n2026-09-08T12:00:00Z,gpt-5.6-terra")).toThrow("columns");
});
