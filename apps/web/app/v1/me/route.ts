/**
 * `GET /v1/me` — profile, arenas, trust tier (`SPEC.md#7`).
 * `PATCH /v1/me` — claim or change the handle.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  claimHandle,
  devices,
  getDb,
  membershipsFor,
  HANDLE_MAX,
  HANDLE_MIN,
  deleteAccount,
} from "@usurp/db";
import { NextResponse } from "next/server";
import { clearSessionCookie, requireUser } from "../../../lib/session";
import {
  bodyError,
  limitRequest,
  readJson,
  sameOrigin,
} from "../../../lib/request";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const db = getDb();
  const [memberships, deviceRows] = await Promise.all([
    membershipsFor(db, auth.user.id),
    db
      .select({
        id: devices.id,
        label: devices.label,
        trustTier: devices.trustTier,
        lastSeenAt: devices.lastSeenAt,
        createdAt: devices.createdAt,
        revokedAt: devices.revokedAt,
      })
      .from(devices)
      .where(eq(devices.userId, auth.user.id)),
  ]);

  return NextResponse.json({
    handle: auth.user.handle,
    handle_confirmed: auth.user.handleConfirmed,
    display_name: auth.user.displayName,
    avatar_url: auth.user.avatarUrl,
    email_domain: auth.user.emailDomain,
    // `#3.4` — a shadow-frozen user is told, rather than left wondering why
    // their rank stopped moving.
    review_state: auth.user.reviewState,
    created_at: auth.user.createdAt,
    arenas: memberships.map((m) => ({
      id: m.arena.id,
      slug: m.arena.slug,
      name: m.arena.name,
      type: m.arena.type,
      visibility: m.visibility,
      status: m.status,
      joined_at: m.joinedAt,
      member_count: m.memberCount,
      max_members: m.arena.maxMembers,
      // Only ever populated for the owner — it is the join secret.
      invite_code: m.inviteCode,
      is_owner: m.arena.ownerUserId === auth.user.id,
    })),
    devices: deviceRows.map((d) => ({
      id: d.id,
      label: d.label,
      trust_tier: d.trustTier,
      last_seen_at: d.lastSeenAt,
      created_at: d.createdAt,
      revoked: d.revokedAt !== null,
    })),
  });
}

const patchSchema = z
  .object({
    handle: z.string().min(HANDLE_MIN).max(HANDLE_MAX).optional(),
  })
  .strict();

/** Human-readable reasons, so the UI does not have to map codes itself. */
const HANDLE_MESSAGES: Record<string, string> = {
  too_short: `Handles must be at least ${HANDLE_MIN} characters.`,
  too_long: `Handles must be at most ${HANDLE_MAX} characters.`,
  invalid_characters:
    "Use letters, digits, underscores and hyphens, starting and ending with a letter or digit.",
  reserved: "That handle is reserved.",
  taken: "That handle is already taken.",
};

export async function PATCH(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const limited = await limitRequest("profile-update", auth.user.id, 10);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await readJson(request, 1024);
  } catch (error) {
    return bodyError(error);
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

  if (parsed.data.handle === undefined) {
    return NextResponse.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const result = await claimHandle(getDb(), auth.user.id, parsed.data.handle);
  if (!result.ok) {
    // 409 for a collision, 422 for a value that could never be valid.
    const status = result.rejection === "taken" ? 409 : 422;
    return NextResponse.json(
      {
        error: result.rejection,
        detail:
          HANDLE_MESSAGES[result.rejection] ?? "That handle cannot be used.",
      },
      { status },
    );
  }

  return NextResponse.json({
    handle: result.user.handle,
    handle_confirmed: result.user.handleConfirmed,
  });
}

export async function DELETE(request: Request): Promise<NextResponse> {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const limited = await limitRequest("account-delete", auth.user.id, 5);
  if (limited) return limited;
  let body;
  try {
    body = await readJson(request, 1024);
  } catch (error) {
    return bodyError(error);
  }
  const parsed = z
    .object({ confirmation: z.string().max(32) })
    .strict()
    .safeParse(body);
  if (
    !parsed.success ||
    !(await deleteAccount(getDb(), auth.user.id, parsed.data.confirmation))
  ) {
    return NextResponse.json(
      { error: "Type your exact handle to confirm deletion." },
      { status: 400 },
    );
  }
  const response = NextResponse.json(
    { deleted: true },
    { headers: { "cache-control": "no-store" } },
  );
  clearSessionCookie(response);
  return response;
}
