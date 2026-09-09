/**
 * `DELETE /v1/me/devices/:id` — revoke a device.
 *
 * The remedy for a lost laptop or a key you think leaked. Revocation, not
 * deletion: `#3.4`'s monotonic `last_seq` is what stops a captured payload from
 * being replayed later, and deleting the row would discard that and free the
 * `device_id` for reuse. `usage_events` already submitted stay — they are real
 * work, and `#6.2` keeps history intact.
 */

import { and, eq, isNull } from "drizzle-orm";
import { devices, getDb } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../../lib/session";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const { id } = await context.params;

  // Scoped to the caller's own devices, so a guessed device id from someone
  // else's account revokes nothing.
  const [revoked] = await getDb()
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(devices.id, id), eq(devices.userId, auth.user.id), isNull(devices.revokedAt)),
    )
    .returning({ id: devices.id, revokedAt: devices.revokedAt });

  if (!revoked) {
    // Covers "not yours", "does not exist", and "already revoked" identically.
    return NextResponse.json({ error: "device_not_found" }, { status: 404 });
  }

  return NextResponse.json({ id: revoked.id, revoked_at: revoked.revokedAt });
}
