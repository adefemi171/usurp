/**
 * `GET /auth/:provider` — start sign-in.
 *
 * Issues the signed state cookie and redirects to the provider.
 */

import { NextResponse } from "next/server";
import { getProvider, safeReturnTo, startFlow } from "../../../lib/oauth";
import { setOAuthCookie } from "../../../lib/session";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider: providerId } = await context.params;
  const provider = getProvider(providerId);

  if (!provider) {
    // 404 rather than 400: an unconfigured or disabled provider should be
    // indistinguishable from one that does not exist, so probing for `dev`
    // reveals nothing about how the server is configured.
    return NextResponse.json({ error: "unknown_provider" }, { status: 404 });
  }

  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("return_to"));
  const { authorizeUrl, cookie } = startFlow(provider, returnTo);

  const response = NextResponse.redirect(authorizeUrl, { status: 302 });
  setOAuthCookie(response, cookie);
  return response;
}
