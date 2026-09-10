import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb, issueEmailChallenge, consumeEmailChallenge, invalidateEmailChallenge, signInWithOAuth, createSession, linkEmailIdentity } from "@usurp/db";
import { authSecret, baseUrl, emailAuthEnabled, isSecureOrigin } from "../../../lib/env";
import { currentUser, setSessionCookie } from "../../../lib/session";
import { safeReturnTo } from "../../../lib/return-to";
import { sendSignInCode } from "../../../lib/email";

const COOKIE = "usurp_email_challenge";
const cookieOptions = () => ({ httpOnly: true, secure: isSecureOrigin(), sameSite: "strict" as const, path: "/auth/email", maxAge: 600 });
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(baseUrl()).origin) return NextResponse.json({ error: "Request must come from this website." }, { status: 403 });
  if (!emailAuthEnabled()) return NextResponse.json({ error: "Email sign-in is not configured yet. Please use GitHub." }, { status: 503 });
  if (!request.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "Invalid request." }, { status: 415 });
  const raw = await request.text();
  if (raw.length > 2048) return NextResponse.json({ error: "Request too large." }, { status: 413 });
  let body: { action?: string; email?: string; code?: string; returnTo?: string };
  try { body = JSON.parse(raw); if (!body || typeof body !== "object") throw Error(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const db = getDb();
  const user = await currentUser();
  if (body.action === "send") {
    if (typeof body.email !== "string") return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    let challenge;
    try { challenge = await issueEmailChallenge(db, { email: body.email, secret: authSecret(), returnTo: typeof body.returnTo === "string" ? safeReturnTo(body.returnTo) : "/settings", ...(user ? { linkUserId: user.id } : {}) }); }
    catch (err) { const reason = err instanceof Error ? err.message : ""; return NextResponse.json({ error: reason === "email_rate_limited" ? "Please wait before requesting another code. Try again later if you have requested several." : "Could not send a code. Check your email address and try again." }, { status: reason === "email_rate_limited" ? 429 : 400 }); }
    try { await sendSignInCode(challenge.email, challenge.code); }
    catch { await invalidateEmailChallenge(db, challenge.token); return NextResponse.json({ error: "We could not send your code. Please try again later or use GitHub." }, { status: 502 }); }
    const response = NextResponse.json({ ok: true });
    response.cookies.set(COOKIE, challenge.token, cookieOptions());
    return response;
  }
  if (body.action !== "verify" || typeof body.code !== "string") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const token = (await cookies()).get(COOKIE)?.value ?? "";
  const verified = await consumeEmailChallenge(db, token, body.code.trim(), authSecret(), user?.id);
  if (!verified) return NextResponse.json({ error: "Code invalid or expired. Check the code, or request a new one after five unsuccessful attempts." }, { status: 400 });
  if (verified.linkUserId) {
    const linked = await linkEmailIdentity(db, verified.linkUserId, verified.email);
    const response = NextResponse.json(linked ? { ok: true, destination: "/settings?email=linked" } : { error: "That email is already linked to another Usurp account. Accounts have not been merged." }, { status: linked ? 200 : 409 });
    response.cookies.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 });
    return response;
  }
  const result = await signInWithOAuth(db, { provider: "email", providerUid: verified.email, email: verified.email });
  const session = await createSession(db, result.user.id);
  const response = NextResponse.json({ ok: true, destination: safeReturnTo(verified.returnTo) });
  setSessionCookie(response, session.token, session.expiresAt);
  response.cookies.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 });
  return response;
}
