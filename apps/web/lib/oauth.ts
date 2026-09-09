/**
 * OAuth 2.0 authorization-code flow — `SPEC.md#8` (GitHub + Google).
 *
 * Two defences, deliberately both:
 *
 *   `state`  a random value round-tripped through a signed, HttpOnly cookie.
 *            Without it, an attacker can feed you *their* authorization code
 *            and silently link your session to their account.
 *   PKCE     an `S256` challenge, where the provider supports it. Protects the
 *            code against interception between the redirect and the exchange.
 *
 * GitHub's classic OAuth Apps do not implement PKCE, so it is declared
 * per-provider rather than assumed — sending a challenge a provider ignores
 * would give the appearance of protection without any.
 *
 * The state cookie is HMAC-signed rather than stored in a table: it is a
 * 10-minute single-use value, and a database row per sign-in attempt is a
 * write, a read, and a cleanup job for something a signature already settles.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthProfile } from "@usurp/db";
import {
  authSecret,
  baseUrl,
  devAuthEnabled,
  githubCredentials,
  googleCredentials,
  type OAuthCredentials,
} from "./env";

export type ProviderId = "github" | "google" | "dev";

export interface Provider {
  id: ProviderId;
  label: string;
  /** Whether the provider honours an `S256` PKCE challenge. */
  usesPkce: boolean;
  scope: string;
  authorizeUrl: string;
  tokenUrl: string;
  credentials(): OAuthCredentials | undefined;
  fetchProfile(accessToken: string): Promise<OAuthProfile>;
}

function redirectUri(provider: ProviderId): string {
  return `${baseUrl()}/auth/${provider}/callback`;
}

// ── GitHub ─────────────────────────────────────────────────────────────────

interface GitHubUser {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
}

interface GitHubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

const github: Provider = {
  id: "github",
  label: "GitHub",
  // Classic OAuth Apps ignore code_challenge.
  usesPkce: false,
  scope: "read:user user:email",
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  credentials: githubCredentials,

  async fetchProfile(accessToken) {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "usurp",
    };

    const userResponse = await fetch("https://api.github.com/user", { headers });
    if (!userResponse.ok) {
      throw new Error(`github /user returned ${userResponse.status}`);
    }
    const user = (await userResponse.json()) as GitHubUser;
    if (user.id === undefined) throw new Error("github /user returned no id");

    // The profile email may be private, so ask for the address list. Only a
    // *verified primary* is trusted — `#2` builds org verification on the
    // domain, and an unverified address would let anyone claim any employer.
    let email = user.email ?? undefined;
    if (!email) {
      const emailResponse = await fetch("https://api.github.com/user/emails", { headers });
      if (emailResponse.ok) {
        const list = (await emailResponse.json()) as GitHubEmail[];
        email = list.find((e) => e.primary && e.verified)?.email ?? undefined;
      }
    }

    return {
      provider: "github",
      // Numeric id, not the login: logins can be changed and reused.
      providerUid: String(user.id),
      ...(user.login ? { username: user.login } : {}),
      ...(user.name ? { displayName: user.name } : {}),
      ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
      ...(email ? { email } : {}),
    };
  },
};

// ── Google ─────────────────────────────────────────────────────────────────

interface GoogleUserInfo {
  sub?: string;
  name?: string;
  picture?: string;
  email?: string;
  email_verified?: boolean;
}

const google: Provider = {
  id: "google",
  label: "Google",
  usesPkce: true,
  scope: "openid email profile",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  credentials: googleCredentials,

  async fetchProfile(accessToken) {
    const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`google userinfo returned ${response.status}`);

    const info = (await response.json()) as GoogleUserInfo;
    if (!info.sub) throw new Error("google userinfo returned no sub");

    return {
      provider: "google",
      providerUid: info.sub,
      ...(info.email ? { username: info.email.split("@")[0]! } : {}),
      ...(info.name ? { displayName: info.name } : {}),
      ...(info.picture ? { avatarUrl: info.picture } : {}),
      // Unverified addresses are dropped rather than stored.
      ...(info.email && info.email_verified !== false ? { email: info.email } : {}),
    };
  },
};

// ── dev ────────────────────────────────────────────────────────────────────

/**
 * Local-only provider, so M1 is testable without registered OAuth apps.
 *
 * Real OAuth needs a client id, a secret, and a publicly reachable callback.
 * Without this, handles, visibility, clubs and enrollment could be written but
 * never exercised. It is gated on `devAuthEnabled()` — `NODE_ENV !==
 * production` **and** an explicit `USURP_DEV_AUTH=1` — and the route refuses to
 * exist otherwise, so it cannot be reached by a single misconfiguration.
 */
const dev: Provider = {
  id: "dev",
  label: "Dev sign-in",
  usesPkce: false,
  scope: "",
  // Its own top-level path, not `/auth/dev/...`: a static `auth/dev/`
  // directory would shadow the `auth/[provider]` dynamic route.
  authorizeUrl: `${baseUrl()}/dev-signin`,
  tokenUrl: "",
  credentials: () => ({ clientId: "dev", clientSecret: "dev" }),
  async fetchProfile(accessToken) {
    // The "access token" is the chosen handle; the prompt page is the whole
    // authorization step.
    const username = accessToken.trim().toLowerCase();
    return {
      provider: "dev",
      // Stable per handle, so signing in twice as "kenn" is the same account.
      providerUid: `dev:${username}`,
      username,
      displayName: username,
      email: `${username}@dev.local`,
    };
  },
};

const PROVIDERS: Record<ProviderId, Provider> = { github, google, dev };

/** Look up a usable provider. Returns undefined if unconfigured or disabled. */
export function getProvider(id: string): Provider | undefined {
  if (id === "dev") return devAuthEnabled() ? dev : undefined;
  if (id !== "github" && id !== "google") return undefined;
  const provider = PROVIDERS[id];
  return provider.credentials() ? provider : undefined;
}

// ── state cookie ───────────────────────────────────────────────────────────

interface StatePayload {
  /** provider */
  p: ProviderId;
  /** state */
  s: string;
  /** PKCE verifier, when used */
  v?: string;
  /** post-sign-in destination */
  r: string;
  /** expiry, ms since epoch */
  e: number;
}

function sign(data: string): string {
  return createHmac("sha256", authSecret()).update(data).digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface StartedFlow {
  authorizeUrl: string;
  /** Value for the OAuth cookie. */
  cookie: string;
}

/**
 * Only same-origin relative paths are accepted as a return destination.
 *
 * An open redirect on a sign-in route is a phishing primitive: it lets an
 * attacker send a victim through *your* domain and land them anywhere.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  // `//evil.com` and `/\evil.com` are protocol-relative and leave the origin.
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

export function startFlow(provider: Provider, returnTo: string): StartedFlow {
  const state = randomBytes(32).toString("base64url");
  const verifier = provider.usesPkce ? randomBytes(32).toString("base64url") : undefined;

  const payload: StatePayload = {
    p: provider.id,
    s: state,
    ...(verifier ? { v: verifier } : {}),
    r: safeReturnTo(returnTo),
    e: Date.now() + 600_000,
  };

  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const cookie = `${body}.${sign(body)}`;

  const credentials = provider.credentials()!;
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: redirectUri(provider.id),
    response_type: "code",
    state,
  });
  if (provider.scope) params.set("scope", provider.scope);

  if (verifier) {
    params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    params.set("code_challenge_method", "S256");
  }

  return { authorizeUrl: `${provider.authorizeUrl}?${params}`, cookie };
}

export type FlowRejection = "missing_cookie" | "bad_signature" | "expired" | "state_mismatch" | "provider_mismatch";

export type VerifiedFlow =
  | { ok: true; returnTo: string; verifier?: string }
  | { ok: false; rejection: FlowRejection };

/** Validate the callback against the cookie. */
export function verifyFlow(
  cookieValue: string | undefined,
  providerId: ProviderId,
  stateParam: string | null,
): VerifiedFlow {
  if (!cookieValue) return { ok: false, rejection: "missing_cookie" };

  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return { ok: false, rejection: "bad_signature" };

  const body = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!constantTimeEqual(signature, sign(body))) {
    return { ok: false, rejection: "bad_signature" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, rejection: "bad_signature" };
  }

  if (typeof payload.e !== "number" || payload.e < Date.now()) {
    return { ok: false, rejection: "expired" };
  }
  if (payload.p !== providerId) return { ok: false, rejection: "provider_mismatch" };
  if (!stateParam || !constantTimeEqual(payload.s, stateParam)) {
    return { ok: false, rejection: "state_mismatch" };
  }

  return {
    ok: true,
    returnTo: safeReturnTo(payload.r),
    ...(payload.v ? { verifier: payload.v } : {}),
  };
}

// ── token exchange ─────────────────────────────────────────────────────────

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(
  provider: Provider,
  code: string,
  verifier: string | undefined,
): Promise<string> {
  // The dev provider has no token endpoint: the code *is* the handle.
  if (provider.id === "dev") return code;

  const credentials = provider.credentials()!;
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    redirect_uri: redirectUri(provider.id),
    grant_type: "authorization_code",
  });
  if (verifier) body.set("code_verifier", verifier);

  const response = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`${provider.id} token endpoint returned non-JSON (${response.status})`);
  }

  if (parsed.error || !parsed.access_token) {
    // Provider error text is safe to log but must not reach the browser: it can
    // echo the client id and other request details.
    throw new Error(
      `${provider.id} token exchange failed: ${parsed.error ?? "no access_token"}` +
        (parsed.error_description ? ` (${parsed.error_description})` : ""),
    );
  }

  return parsed.access_token;
}
