import { NextResponse } from "next/server";
import { signedOutcomeSchema } from "@usurp/protocol";
import { acceptOutcome, getDb } from "@usurp/db";
import { readJson, bodyError, limitRequest, reportError } from "../../../lib/request";

export async function POST(request: Request) {
  const limited = await limitRequest("outcome-ingest", "deployment", 600);
  if (limited) return limited;
  let body: unknown;
  try { body = await readJson(request, 4096); } catch (e) { return bodyError(e); }
  const parsed = signedOutcomeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_proof" }, { status: 400 });
  try {
    const result = await acceptOutcome(getDb(), parsed.data);
    return NextResponse.json(result, { status: result.ok ? 200 : result.error === "unlinked_or_revoked" ? 403 : 409 });
  } catch { reportError("outcome-ingest"); return NextResponse.json({ error: "temporarily_unavailable" }, { status: 503 }); }
}
