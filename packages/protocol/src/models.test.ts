import { expect, it } from "vitest";
import { costMicros, normalizeModelId } from "./models.js";
it("prices Terra and Astra and applies context bands including cache", () => {
  const counts = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 };
  expect(costMicros("gpt-5.6-terra", counts)).toBe(3200);
  expect(costMicros("gpt-6-astra", counts)).toBe(15000);
  expect(costMicros("gpt-5.6-sol", { ...counts, cacheReadTokens: 272000 })).toBe(228600);
  expect(costMicros("codex-auto-review", counts)).toBe(0);
  expect(normalizeModelId("claude-opus-5-thinking-high")).toBe("claude-opus-5");
});
