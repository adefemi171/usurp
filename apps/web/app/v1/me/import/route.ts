import { importManual, getDb } from "@usurp/db";
import { bucketSchema } from "@usurp/protocol";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "../../../../lib/session";
import {
  bodyError,
  limitRequest,
  readJson,
  sameOrigin,
  reportError,
} from "../../../../lib/request";
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const limited = await limitRequest(
    "manual-import",
    auth.user.id,
    10,
    3600_000,
  );
  if (limited) return limited;
  let body;
  try {
    body = await readJson(request, 1024 * 1024);
  } catch (error) {
    return bodyError(error);
  }
  const parsed = z
    .object({
      buckets: z.array(bucketSchema).min(1).max(1000),
      consent: z.literal(true),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid_aggregate_payload" },
      { status: 400 },
    );
  try {
    const result = await importManual(
      getDb(),
      auth.user.id,
      parsed.data.buckets,
    );
    return NextResponse.json(result, {
      status: result.rejected.length ? 422 : 200,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "device_revoked")
      return NextResponse.json(
        { error: "Manual imports have been revoked for this account." },
        { status: 409 },
      );
    reportError("manual-import");
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
}
