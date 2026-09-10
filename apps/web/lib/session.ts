/**
 * Session cookies and the current-user lookup.
 *
 * Cookie attributes are the security boundary here:
 *
 *   HttpOnly              JS cannot read the token, so an XSS bug does not
 *                         immediately become account takeover.
 *   SameSite=Lax          the cookie is not sent on cross-site POSTs, which is
 *                         what makes the state-changing routes CSRF-resistant
 *                         without a per-form token. `Lax` rather than `Strict`
 *                         so arriving from an external link keeps you signed in
 *                         — `Strict` would break the OAuth callback itself.
 *   Secure                only over HTTPS. Derived from the configured origin
 *                         rather than hardcoded, because `Secure` on a
 *                         localhost HTTP dev server silently drops the cookie.
 *   Path=/                the API and the pages share it.
 */

import { cookies } from "next/headers";
import { cache } from "react";
import type { NextResponse } from "next/server";
import { getDb, resolveSession, type User } from "@usurp/db";
import { isSecureOrigin } from "./env";

export const SESSION_COOKIE = "usurp_session";
export const OAUTH_COOKIE = "usurp_oauth";

/** OAuth round trips should take seconds; ten minutes is generous. */
export const OAUTH_COOKIE_MAX_AGE_S = 600;

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureOrigin(),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
): void {
  const maxAge = Math.max(
    1,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  response.cookies.set(SESSION_COOKIE, token, cookieOptions(maxAge));
}

export function clearSessionCookie(response: NextResponse): void {
  // Empty value plus maxAge 0 — some clients keep a cookie set only to "".
  response.cookies.set(SESSION_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
}

export function setOAuthCookie(response: NextResponse, value: string): void {
  response.cookies.set(
    OAUTH_COOKIE,
    value,
    cookieOptions(OAUTH_COOKIE_MAX_AGE_S),
  );
}

export function clearOAuthCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_COOKIE, "", { ...cookieOptions(0), maxAge: 0 });
}

/** Read the raw session token from the request. */
export async function sessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value;
}

export async function oauthCookie(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(OAUTH_COOKIE)?.value;
}

/**
 * The signed-in user, or `undefined`.
 *
 * Not cached across requests on purpose: the point of database-backed sessions
 * is that revocation is immediate, and a process-level cache would reintroduce
 * exactly the staleness a self-contained token has.
 */
// React cache deduplicates within one server render only; it never shares a
// session across requests. Layout, page and board otherwise repeat this query.
export const currentUser = cache(async (): Promise<User | undefined> => {
  const token = await sessionToken();
  if (!token) return undefined;
  const resolved = await resolveSession(getDb(), token);
  return resolved?.user;
});

/** For route handlers that must have a user. Returns the 401 body to send. */
export async function requireUser(): Promise<
  { ok: true; user: User } | { ok: false; status: 401; body: { error: string } }
> {
  const user = await currentUser();
  if (!user) {
    return { ok: false, status: 401, body: { error: "not_authenticated" } };
  }
  return { ok: true, user };
}
