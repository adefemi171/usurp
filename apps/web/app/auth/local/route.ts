import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { createSession, getDb, signInWithOAuth, users } from "@usurp/db";
import { baseUrl } from "../../../lib/env";
import { localAuthEnabled, localPasswordMatches } from "../../../lib/local-auth";
import { setSessionCookie } from "../../../lib/session";
import { limitRequest, sameOrigin } from "../../../lib/request";

export async function POST(request: Request) {
  if (!localAuthEnabled()) return new NextResponse(null, { status: 404 });
  const origin = new URL(baseUrl());
  if (!sameOrigin(request) || request.headers.get("host") !== origin.host)
    return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  const limited = await limitRequest("local-login", "owner", 10);
  if (limited) return limited;
  // The normal form contains one short password. Bound the streamed body too.
  const reader = request.body?.getReader();
  if (!reader) return new NextResponse(null, { status: 400 });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) { await reader.cancel(); return new NextResponse(null, { status: 413 }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const password = new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("password") ?? "";
  if (!localPasswordMatches(password))
    return NextResponse.redirect(new URL("/signin?error=local_password", origin), 303);
  const db = getDb();
  const ownerId = process.env.USURP_LOCAL_OWNER_ID;
  // Existing accounts are selected explicitly by the operator, never by a supplied handle.
  const user = ownerId
    ? (await db.select().from(users).where(eq(users.id, ownerId)).limit(1))[0]
    : (await signInWithOAuth(db, { provider: "local", providerUid: "owner", username: "adefemi171" })).user;
  if (!user) return NextResponse.json({ error: "local_owner_not_found" }, { status: 409 });
  const session = await createSession(db, user.id);
  const response = NextResponse.redirect(new URL("/settings", origin), 303);
  response.headers.set("cache-control", "no-store");
  setSessionCookie(response, session.token, session.expiresAt);
  return response;
}
