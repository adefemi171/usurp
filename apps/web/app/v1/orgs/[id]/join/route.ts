import { getDb, joinOrg } from "@usurp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "../../../../../lib/session";
import { bodyError, readJson, sameOrigin } from "../../../../../lib/request";
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
  let body;
  try {
    body = await readJson(request, 1024);
  } catch (error) {
    return bodyError(error);
  }
  const parsed = z
    .object({ consent: z.literal(true) })
    .strict()
    .safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  try {
    await joinOrg(getDb(), auth.user.id, id, true);
    return NextResponse.json({ joined: true, visibility: "hidden" });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return NextResponse.json(
      {
        error: [
          "consent_required",
          "org_not_verified",
          "verified_work_email_required",
          "already_in_org",
        ].includes(code)
          ? code
          : "Unable to join organization.",
      },
      { status: 409 },
    );
  }
}
