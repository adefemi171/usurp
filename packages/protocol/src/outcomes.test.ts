import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { generateDeviceKeyPair } from "./keys.js";
import { signOutcome, verifyOutcome, signedOutcomeSchema, experimentSummary, type Outcome } from "./outcomes.js";
const keys = generateDeviceKeyPair();
const base: Outcome = { version: 1, id: randomUUID(), missionId: randomUUID(), publicKey: keys.publicKey, kind: "test", passed: true, startedAt: "2026-09-22T00:00:00.000Z", finishedAt: "2026-09-22T00:00:01.000Z", durationMs: 1000 };
describe("outcome proofs", () => {
  it("binds identity, timing, mission, result and experiment to the signature", () => {
    const value = signOutcome(base, keys.privateKeyPem);
    expect(verifyOutcome(value)).toBe(true);
    for (const change of [{ passed: false }, { missionId: randomUUID() }, { durationMs: 10 }, { kind: "pr" as const }, { experimentId: randomUUID(), variant: "baseline" as const }]) expect(verifyOutcome({ ...value, outcome: { ...base, ...change } })).toBe(false);
  });
  it("rejects extra sensitive fields and impossible timing", () => {
    const proof = signOutcome(base, keys.privateKeyPem);
    expect(signedOutcomeSchema.safeParse({ ...proof, outcome: { ...base, command: "secret" } }).success).toBe(false);
    expect(signedOutcomeSchema.safeParse({ ...proof, outcome: { ...base, durationMs: -1 } }).success).toBe(false);
    expect(signedOutcomeSchema.safeParse({ ...proof, outcome: { ...base, experimentId: randomUUID() } }).success).toBe(false);
  });
  it("withholds a comparison for insufficient samples and flags worse pass rates", () => {
    expect(experimentSummary([]).durationChangePercent).toBeNull();
    const rows = [0, 1, 2].flatMap(i => [{ ...base, variant: "baseline" as const }, { ...base, variant: "intervention" as const, durationMs: 500, passed: i !== 2 }]);
    expect(experimentSummary(rows)).toMatchObject({ durationChangePercent: -50, qualityMaintained: false });
  });
});
