/**
 * `GET /auth/:provider/callback` — finish sign-in.
 *
 * Order is load-bearing: validate the state cookie *before* spending a token
 * exchange on the code. An attacker-supplied code that fails state validation
 * must never reach the provider, or the endpoint becomes a way to burn our
 * rate limit and confirm code validity.
 */

import { NextResponse } from "next/server";
import { createSession, getDb, signInWithOAuth } from "@usurp/db";
import { exchangeCode, getProvider, verifyFlow } from "../../../../lib/oauth";
import {
  clearOAuthCookie,
  oauthCookie,
  setSessionCookie,
} from "../../../../lib/session";
import { baseUrl } from "../../../../lib/env";

export const dynamic = "force-dynamic";

/** Send the user somewhere useful with a message, rather than a bare JSON error. */
function fail(reason: string): NextResponse {
  const url = new URL("/signin", baseUrl());
  url.searchParams.set("error", reason);
  const response = NextResponse.redirect(url, { status: 302 });
  clearOAuthCookie(response);
  return response;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider: providerId } = await context.params;
  const provider = getProvider(providerId);
  if (!provider) return NextResponse.json({ error: "unknown_provider" }, { status: 404 });

  const url = new URL(request.url);

  // The user declined at the provider, or the provider errored.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return fail(providerError === "access_denied" ? "cancelled" : "provider_error");
  }

  const code = url.searchParams.get("code");
  if (!code) return fail("missing_code");

  const flow = verifyFlow(await oauthCookie(), provider.id, url.searchParams.get("state"));
  if (!flow.ok) {
    console.warn(`oauth callback rejected: ${flow.rejection} (${provider.id})`);
    // One message for every rejection reason — distinguishing "expired" from
    // "state mismatch" to the browser tells an attacker which half worked.
    return fail("invalid_state");
  }

  let profile;
  try {
    const accessToken = await exchangeCode(provider, code, flow.verifier);
    profile = await provider.fetchProfile(accessToken);
  } catch (err) {
    // Provider error detail can echo the client id; log it, don't return it.
    console.error("oauth exchange failed", err);
    return fail("exchange_failed");
  }

  let session;
  let created;
  try {
    const result = await signInWithOAuth(getDb(), profile);
    created = result.created;
    session = await createSession(getDb(), result.user.id, {
      ...(request.headers.get("user-agent")
        ? { userAgent: request.headers.get("user-agent")! }
        : {}),
    });
  } catch (err) {
    console.error("sign-in failed", err);
    return fail("signin_failed");
  }

  // Preserve device approval across first-time sign-in; handle setup can wait.
  const pairingReturn = flow.returnTo.startsWith("/connect/approve?");
  const destination = created && !pairingReturn ? "/settings?welcome=1" : flow.returnTo;
  const response = NextResponse.redirect(new URL(destination, baseUrl()), { status: 302 });

  setSessionCookie(response, session.token, session.expiresAt);
  clearOAuthCookie(response);
  return response;
}
