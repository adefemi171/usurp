/**
 * `POST /auth/signout` — end this session.
 *
 * POST only. A GET sign-out is triggerable by any `<img src>` on any page, so
 * a prefetcher or a hostile site can log people out at will. Combined with the
 * `SameSite=Lax` session cookie, requiring POST means a cross-site form cannot
 * reach it either.
 */

import { NextResponse } from "next/server";
import { destroyAllSessions, destroySession, getDb, resolveSession } from "@usurp/db";
import { clearSessionCookie, sessionToken } from "../../../lib/session";
import { baseUrl } from "../../../lib/env";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const token = await sessionToken();

  if (token) {
    try {
      const url = new URL(request.url);
      if (url.searchParams.get("all") === "1") {
        // "Sign out everywhere" — the remedy for a cookie you think leaked.
        const resolved = await resolveSession(getDb(), token);
        if (resolved) await destroyAllSessions(getDb(), resolved.user.id);
      } else {
        await destroySession(getDb(), token);
      }
    } catch (err) {
      // Clear the cookie regardless: a user who asked to sign out must end up
      // signed out locally even if the delete failed.
      console.error("signout failed", err);
    }
  }

  const accepts = request.headers.get("accept") ?? "";
  const response = accepts.includes("application/json")
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(new URL("/", baseUrl()), { status: 303 });

  clearSessionCookie(response);
  return response;
}
