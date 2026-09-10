/**
 * Liveness + readiness for the compose healthcheck.
 *
 * Actually queries the database rather than returning a static 200: a web
 * container that cannot reach Postgres is not healthy, and reporting it as
 * healthy is how a deploy silently serves an empty board.
 */

import { getSql } from "@usurp/db";
import { NextResponse } from "next/server";
import { reportError } from "../../../lib/request";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const sql = getSql();
    await sql`select 1`;
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (process.env.USURP_QA === "1" && process.env.NODE_ENV !== "production") {
      const [row] = await sql`select current_database() as name`;
      headers["x-usurp-qa-database"] = String(row!.name);
    }
    return NextResponse.json({ ok: true, db: "up" }, { headers });
  } catch {
    const incident = reportError("health-database");
    return NextResponse.json(
      { ok: false, db: "down", incident },
      { status: 503 },
    );
  }
}
