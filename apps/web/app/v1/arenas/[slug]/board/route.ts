/**
 * `GET /v1/arenas/:slug/board` — `SPEC.md#7`.
 *
 * M0 serves `metric=burn` only. `metric=rating` is M2, and returning a 501 for
 * it is deliberate: `#4.1` insists the two boards be honestly labelled, and
 * quietly aliasing rating to burn would be exactly the conflation the spec
 * warns against.
 */

import { z } from "zod";
import { burnBoard, getDb, ratingBoard } from "@usurp/db";
import { NextResponse } from "next/server";

const querySchema = z.object({
  window: z.enum(["day", "week", "month", "all"]).default("week"),
  metric: z.enum(["burn", "rating"]).default("burn"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  const url = new URL(request.url);

  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const { window, metric, limit, offset } = parsed.data;

  if (metric === "rating") {
    // Live as of M2: the `#4.4` gate passed, so the rating board is real.
    try {
      const board = await ratingBoard(getDb(), slug, { limit, offset });
      if (!board) {
        return NextResponse.json({ error: "arena_not_found" }, { status: 404 });
      }
      return NextResponse.json({
        arena: board.arena,
        metric: "rating",
        // `#4.1` — this is the board titles and elimination attach to, so it
        // says so rather than leaving a client to infer it from the metric.
        label: "rating — the league",
        season: board.season,
        total: board.total,
        limit,
        offset,
        rows: board.rows,
      });
    } catch (err) {
      console.error("rating board query failed", err);
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  }

  let board;
  try {
    board = await burnBoard(getDb(), slug, { window, limit, offset });
  } catch (err) {
    console.error("board query failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!board) {
    return NextResponse.json({ error: "arena_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    arena: board.arena,
    metric: "burn",
    // `#4.1` — label it as volume, not skill, in the payload itself so an
    // embedder cannot present it as a skill ranking by accident.
    label: "volume, not skill",
    window: board.window,
    total: board.total,
    limit,
    offset,
    rows: board.rows,
  });
}
