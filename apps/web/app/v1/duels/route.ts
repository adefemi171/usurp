import {
  getDb,
  duelsForUser,
  proposeDuel,
  users,
  arenaMembers,
} from "@usurp/db";
import { and, eq } from "drizzle-orm";
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
    { duels: await duelsForUser(getDb(), auth.user.id) },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const auth = await requireUser();
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });
  const limited = await limitRequest(
    "duel-propose",
    auth.user.id,
    10,
    3600_000,
  );
  if (limited) return limited;
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return bodyError(error);
  }
  const parsed = z
    .object({
      arena_id: z.string().uuid(),
      opponent: z.string().min(2).max(32),
      metric: z.enum(["points", "commits", "edits"]),
      wager_pts: z.number().int().min(1).max(1000),
      window: z.enum(["24h", "7d"]),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const p = parsed.data;
  const [opponent] = await getDb()
    .select({ id: users.id })
    .from(users)
    .innerJoin(arenaMembers, eq(arenaMembers.userId, users.id))
    .where(
      and(
        eq(users.handle, p.opponent),
        eq(arenaMembers.arenaId, p.arena_id),
        eq(arenaMembers.visibility, "public"),
        eq(arenaMembers.status, "active"),
      ),
    );
  if (!opponent)
    return NextResponse.json(
      { error: "opponent_not_available" },
      { status: 404 },
    );
  const result = await proposeDuel(getDb(), {
    arenaId: p.arena_id,
    challengerId: auth.user.id,
    opponentId: opponent.id,
    metric: p.metric,
    wagerPts: p.wager_pts,
    window: p.window,
  });
  return NextResponse.json(result, { status: result.ok ? 201 : 409 });
}
