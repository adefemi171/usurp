import { createOrg, getDb, ownedOrgs } from "@usurp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "../../../lib/session";
import {
  bodyError,
  limitRequest,
  readJson,
  sameOrigin,
} from "../../../lib/request";

export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  return NextResponse.json(
    { organizations: await ownedOrgs(getDb(), auth.user.id) },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const limited = await limitRequest("org-create", auth.user.id, 5, 3600_000);
  if (limited) return limited;
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return bodyError(error);
  }
  const parsed = z
    .object({
      name: z.string().min(2).max(48),
      domain: z.string().max(253),
      consent: z.literal(true),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Name, domain, and aggregate-only admin consent are required." },
      { status: 400 },
    );
  try {
    return NextResponse.json(
      await createOrg(
        getDb(),
        auth.user.id,
        parsed.data.name,
        parsed.data.domain,
      ),
      { status: 201 },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return NextResponse.json(
      {
        error: [
          "invalid_domain",
          "personal_email_domain",
          "invalid_name",
          "org_limit",
        ].includes(code)
          ? code
          : "Unable to create organization.",
      },
      { status: 400 },
    );
  }
}
