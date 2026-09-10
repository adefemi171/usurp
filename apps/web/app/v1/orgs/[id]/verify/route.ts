import { getDb, verifyOrg } from "@usurp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "../../../../../lib/session";
import { limitRequest, sameOrigin } from "../../../../../lib/request";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const limited = await limitRequest("org-verify", auth.user.id, 10);
  if (limited) return limited;
  try {
    const verified = await verifyOrg(getDb(), auth.user.id, id);
    return NextResponse.json(
      verified
        ? { verified: true }
        : {
            error:
              "DNS record not found yet. Check the value and allow time for propagation.",
          },
      { status: verified ? 200 : 409 },
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "Verification unavailable: check ownership, expiry, or an existing domain claim.",
      },
      { status: 409 },
    );
  }
}
