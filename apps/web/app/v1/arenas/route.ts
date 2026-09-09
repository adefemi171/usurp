/**
 * `POST /v1/arenas` — create a club, returning its invite code (`SPEC.md#7`).
 *
 * Clubs only. `global` is seeded once by the migration and `org` arenas are
 * created through domain verification in M4 — letting anyone POST one would
 * make the `org_verified` badge meaningless.
 */

import { z } from "zod";
import { CLUB_MAX_MEMBERS, createClub, getDb, NAME_MAX, NAME_MIN } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    name: z.string().min(NAME_MIN).max(NAME_MAX),
    // Accepted and ignored, so a client that sends it gets a clear 400 rather
    // than silently creating a club.
    type: z.literal("club").optional(),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const result = await createClub(getDb(), auth.user.id, parsed.data.name);
  if (!result.ok) {
    const status = result.failure === "too_many_clubs" ? 429 : 422;
    return NextResponse.json({ error: result.failure }, { status });
  }

  return NextResponse.json(
    {
      id: result.arena.id,
      slug: result.arena.slug,
      name: result.arena.name,
      type: result.arena.type,
      invite_code: result.arena.inviteCode,
      max_members: result.arena.maxMembers ?? CLUB_MAX_MEMBERS,
      visibility: result.member.visibility,
    },
    { status: 201 },
  );
}
