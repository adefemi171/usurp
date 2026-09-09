import { z } from "zod";
import { efficiencyFeedback, getDb } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  recommendation: z.enum(["cache", "model", "exploration", "local"]),
  response: z.enum(["useful", "dismissed"]),
}).strict();

/** Stores a private preference, never advice text, prompts, or source activity. */
export async function PUT(request: Request): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const now = new Date();
  await getDb().insert(efficiencyFeedback).values({
    userId: auth.user.id, recommendation: parsed.data.recommendation, response: parsed.data.response, updatedAt: now,
  }).onConflictDoUpdate({
    target: [efficiencyFeedback.userId, efficiencyFeedback.recommendation],
    set: { response: parsed.data.response, updatedAt: now },
  });
  return NextResponse.json({ ok: true });
}
