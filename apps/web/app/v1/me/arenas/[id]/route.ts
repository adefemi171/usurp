/**
 * `PATCH /v1/me/arenas/:id` — set visibility, or leave (`SPEC.md#7`).
 *
 * `#2` makes per-arena visibility the mechanism that keeps an org board from
 * being a surveillance board, so this is the endpoint that invariant actually
 * runs through.
 */

import { z } from "zod";
import { getDb, leaveArena, setVisibility } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../../lib/session";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    visibility: z.enum(["public", "anonymous", "hidden"]).optional(),
    leave: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => v.visibility !== undefined || v.leave === true, {
    message: "provide either visibility or leave",
  });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
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

  if (parsed.data.leave) {
    const result = await leaveArena(getDb(), auth.user.id, id);
    if (!result.ok) {
      // 404, not 403: whether an arena exists that you are not in is not
      // something this endpoint should confirm.
      return NextResponse.json({ error: "not_a_member" }, { status: 404 });
    }
    return NextResponse.json({ left: true });
  }

  const result = await setVisibility(
    getDb(),
    auth.user.id,
    id,
    parsed.data.visibility!,
  );
  if (!result.ok) {
    return NextResponse.json({ error: "not_a_member" }, { status: 404 });
  }

  return NextResponse.json({
    arena_id: result.member.arenaId,
    visibility: result.member.visibility,
  });
}
