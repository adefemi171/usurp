/**
 * `POST /v1/me/enrollments` — mint a device enrollment code for yourself.
 *
 * This is what M1 is actually for. In M0 the only way to get a code was
 * `npm run enroll` on the server, which meant an operator stood between every
 * signup and a working `usurp login`. Now the signed-in user mints their own.
 *
 * The code is shown once and stored only as a SHA-256 (`enrollment.ts`), so it
 * is unrecoverable afterwards — including by us.
 */

import { z } from "zod";
import { ENROLLMENT_TTL_MS, getDb, issueEnrollment } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({ label: z.string().trim().min(1).max(64).optional() })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  // A body is optional; `label` is the only field.
  let body: unknown = {};
  const raw = await request.text();
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const issued = await issueEnrollment(
    getDb(),
    auth.user.id,
    parsed.data.label ? { label: parsed.data.label } : {},
  );

  return NextResponse.json(
    {
      code: issued.code,
      expires_at: issued.expiresAt,
      expires_in_seconds: Math.floor(ENROLLMENT_TTL_MS / 1000),
      // The exact command, so nobody has to assemble it from docs.
      // The CLI is a workspace package until it is published to npm. `npx
      // usurp` would query the registry and fail with ENOVERSIONS.
      command: `npm run usurp -- login ${issued.code}`,
    },
    {
      status: 201,
      // Belt and braces: a proxy or browser cache holding a single-use
      // credential would be a nasty way to leak one.
      headers: { "cache-control": "no-store" },
    },
  );
}
