/**
 * Liveness + readiness for the compose healthcheck.
 *
 * Actually queries the database rather than returning a static 200: a web
 * container that cannot reach Postgres is not healthy, and reporting it as
 * healthy is how a deploy silently serves an empty board.
 */

import { getSql } from "@usurp/db";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const sql = getSql();
    await sql`select 1`;
    return NextResponse.json({ ok: true, db: "up" });
  } catch (err) {
    console.error("health check failed", err);
    return NextResponse.json(
      { ok: false, db: "down", detail: err instanceof Error ? err.message : "unknown" },
      { status: 503 },
    );
  }
}
