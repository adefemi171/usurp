/**
 * `GET /v1/halls/longest-reign` — `SPEC.md#7`, `#5.1`.
 *
 * "Longest Reign is its own permanent hall-of-fame board, so being dethroned
 * still leaves a record — this softens churn at the top and gives a second axis
 * to compete on."
 */

import { z } from "zod";
import { getDb, longestReigns } from "@usurp/db";
import { NextResponse } from "next/server";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Scope to one arena; omit for the all-arena hall. */
  arena: z.string().min(1).max(64).optional(),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);

  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }

  let records;
  try {
    records = await longestReigns(getDb(), {
      limit: parsed.data.limit,
      ...(parsed.data.arena ? { arenaSlug: parsed.data.arena } : {}),
    });
  } catch (err) {
    console.error("hall query failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  return NextResponse.json({
    hall: "longest-reign",
    rows: records.map((r, i) => ({
      rank: i + 1,
      arena: r.arena,
      holder: r.holder,
      started_at: r.startedAt,
      ended_at: r.endedAt,
      days: r.days,
      peak_points: r.peakPoints,
      // An open reign is still growing, which is the point of the board.
      open: r.open,
      ended_by: r.endedBy,
    })),
  });
}
