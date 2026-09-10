import { getDb, orgAggregate } from "@usurp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "../../../../../lib/session";
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const aggregate = await orgAggregate(getDb(), auth.user.id, id);
  return NextResponse.json(aggregate ?? { error: "not_found" }, {
    status: aggregate ? 200 : 404,
    headers: { "cache-control": "no-store" },
  });
}
