/**
 * `POST /v1/arenas/join` — redeem an invite code (`SPEC.md#7`).
 *
 * The 50-member cap and the one-org rule are enforced inside a transaction
 * with the arena row locked (`arenas.ts`), so concurrent redemptions of the
 * last slot cannot both succeed.
 */

import { z } from "zod";
import { getDb, joinByInviteCode } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ invite_code: z.string().min(1).max(64) }).strict();

const MESSAGES: Record<string, string> = {
  invalid_code: "That invite code is not valid.",
  club_full: "That club is full.",
  already_member: "You are already in that arena.",
  already_in_org: "You can only belong to one organization arena.",
};

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
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await joinByInviteCode(getDb(), auth.user.id, parsed.data.invite_code);
  if (!result.ok) {
    const status =
      result.failure === "invalid_code"
        ? 404
        : result.failure === "club_full"
          ? 409
          : 422;
    return NextResponse.json(
      { error: result.failure, detail: MESSAGES[result.failure] },
      { status },
    );
  }

  return NextResponse.json({
    id: result.arena.id,
    slug: result.arena.slug,
    name: result.arena.name,
    type: result.arena.type,
    // `#2` — an org membership starts `hidden`, and the client must show that.
    visibility: result.member.visibility,
    rejoined: result.rejoined,
  });
}
