import { declineDuel, getDb } from "@usurp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "../../../../../lib/session";
import { sameOrigin } from "../../../../../lib/request";
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
  const result = await declineDuel(getDb(), auth.user.id, id);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
