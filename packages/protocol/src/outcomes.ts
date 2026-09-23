import { z } from "zod";
import { canonicalBytes } from "./canonical.js";
import { signBytes, verifyBytes } from "./keys.js";

/** No labels, repository references, commands, logs, or provider credentials. */
export const outcomeSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  missionId: z.string().uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kind: z.enum(["test", "ci", "pr"]),
  passed: z.boolean(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().min(0).max(604800000),
  // Trial grouping is opaque; the intervention's human-readable name stays local.
  experimentId: z.string().uuid().optional(),
  variant: z.enum(["baseline", "intervention"]).optional(),
}).strict().superRefine((v, ctx) => {
  if (Date.parse(v.finishedAt) - Date.parse(v.startedAt) !== v.durationMs || !!v.experimentId !== !!v.variant)
    ctx.addIssue({ code: "custom", message: "Invalid outcome timing or experiment" });
});
export type Outcome = z.infer<typeof outcomeSchema>;
export const signedOutcomeSchema = z.object({ outcome: outcomeSchema, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }).strict();
export type SignedOutcome = z.infer<typeof signedOutcomeSchema>;
export function signOutcome(outcome: Outcome, key: string): SignedOutcome {
  return { outcome: outcomeSchema.parse(outcome), signature: signBytes(canonicalBytes(outcome), key) };
}
export function verifyOutcome(value: SignedOutcome): boolean {
  return verifyBytes(canonicalBytes(value.outcome), value.signature, value.outcome.publicKey);
}

/** A signature authenticates a reporter; only an independently approved key is trusted. */
export function trustedAttestors(raw = ""): string[] {
  return [...new Set(raw.split(",").map(s => s.trim()).filter(s => /^[A-Za-z0-9_-]{43}$/.test(s)))];
}

export function experimentSummary(rows: Outcome[]) {
  const group = (variant: string) => {
    const trials = rows.filter(r => r.variant === variant);
    const passed = trials.filter(r => r.passed);
    return { trials: trials.length, passed: passed.length, meanDurationMs: passed.length ? passed.reduce((n, r) => n + r.durationMs, 0) / passed.length : null };
  };
  const baseline = group("baseline"), intervention = group("intervention");
  const enough = baseline.trials >= 3 && intervention.trials >= 3 && baseline.meanDurationMs !== null && baseline.meanDurationMs > 0 && intervention.meanDurationMs !== null;
  return { baseline, intervention, durationChangePercent: enough ? Math.round((intervention.meanDurationMs! / baseline.meanDurationMs! - 1) * 100) : null,
    qualityMaintained: enough ? intervention.passed / intervention.trials >= baseline.passed / baseline.trials : null };
}
