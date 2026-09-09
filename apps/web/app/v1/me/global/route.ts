/**
 * `POST /v1/me/global` — opt in to the global arena.
 *
 * Deliberately a separate, explicit action rather than part of sign-up. `#2`
 * says global membership is auto-enrolled **on opt-in**, and `#10.2` promises
 * the whole thing is 100% opt-in. Enrolling at account creation would make
 * appearing on a public leaderboard a side effect of signing in, which is the
 * opposite of that promise.
 */

import { getDb, optInToGlobal } from "@usurp/db";
import { NextResponse } from "next/server";
import { requireUser } from "../../../../lib/session";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  // Idempotent: `joinGlobalArena` is an upsert, so a double-click is harmless.
  await optInToGlobal(getDb(), auth.user.id);

  return NextResponse.json({ joined: true, slug: "global" });
}
