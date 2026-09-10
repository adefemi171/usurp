/**
 * `GET /v1/arenas/:slug/feed` — `SPEC.md#7`.
 *
 * "dethrones, duels, eliminations, achievements" — one append-only log (`#6`),
 * so duels and eliminations appear here for free once M3 writes them.
 *
 * Names are resolved through each member's current visibility in the arena, not
 * from `users.handle`. See the note at the top of `feed.ts`.
 */

import { z } from "zod";
import { arenaFeed, getDb } from "@usurp/db";
import { NextResponse } from "next/server";
import { currentUser } from "../../../../../lib/session";
import { canViewArena } from "../../../../../lib/arena-access";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** Cursor: ISO timestamp; returns entries strictly older than this. */
  before: z.coerce.date().optional(),
});

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params;
  if (!(await canViewArena(slug, (await currentUser())?.id)))
    return NextResponse.json({ error: "arena_not_found" }, { status: 404 });
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

  let feed;
  try {
    feed = await arenaFeed(getDb(), slug, {
      limit: parsed.data.limit,
      ...(parsed.data.before ? { before: parsed.data.before } : {}),
    });
  } catch (err) {
    console.error("feed query failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!feed) {
    return NextResponse.json({ error: "arena_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    arena: feed.arena,
    entries: feed.entries.map((e) => ({
      id: e.id,
      type: e.type,
      created_at: e.createdAt,
      // Pre-rendered and visibility-safe, so a client cannot reconstruct a
      // sentence that names someone who opted out of being named.
      text: e.text,
      actor: e.actor,
      target: e.target,
      payload: e.payload,
    })),
    next_before: feed.nextBefore,
  });
}
