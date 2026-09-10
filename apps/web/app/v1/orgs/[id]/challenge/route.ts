import { getDb, renewOrgChallenge } from "@usurp/db";
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
  const limited = await limitRequest(
    "org-challenge",
    auth.user.id,
    5,
    3600_000,
  );
  if (limited) return limited;
  try {
    return NextResponse.json(
      await renewOrgChallenge(getDb(), auth.user.id, id),
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        error:
          "Only the owner of a pending organization can renew its DNS record.",
      },
      { status: 409 },
    );
  }
}
