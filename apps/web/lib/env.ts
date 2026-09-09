/**
 * Runtime configuration, validated once.
 *
 * Config errors should be loud at the edge of the process, not a confusing 500
 * three requests later. Anything required in production is checked here.
 */

const isProduction = process.env.NODE_ENV === "production";

/** Public origin, used to build OAuth redirect URIs. */
export function baseUrl(): string {
  const raw = process.env.USURP_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT ?? 3000}`;
  return raw.replace(/\/+$/, "");
}

export function isSecureOrigin(): boolean {
  return baseUrl().startsWith("https://");
}

/**
 * Secret for HMAC-signing the short-lived OAuth state cookie.
 *
 * Required in production. In development a fixed fallback is used so a fresh
 * clone works without setup — that is safe only because the value it protects
 * (a 10-minute CSRF token) is worthless to an attacker who can already read
 * your local cookies.
 */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (isProduction) {
    throw new Error(
      "AUTH_SECRET must be set to at least 32 characters in production. " +
        "Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
    );
  }
  if (secret) {
    console.warn("AUTH_SECRET is shorter than 32 characters; using it anyway (development)");
    return secret;
  }
  return "usurp-development-only-secret-do-not-use-in-production";
}

/**
 * Whether the `dev` auth provider is available.
 *
 * Two independent conditions, both required. `NODE_ENV !== "production"` alone
 * would be one misconfigured deploy away from a password-free login as any
 * handle; requiring an explicit opt-in as well means an accidental
 * `NODE_ENV=development` in prod still doesn't open it.
 */
export function devAuthEnabled(): boolean {
  return !isProduction && process.env.USURP_DEV_AUTH === "1";
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export function githubCredentials(): OAuthCredentials | undefined {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export function googleCredentials(): OAuthCredentials | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Providers actually usable right now, for rendering the sign-in page. */
export function availableProviders(): Array<"github" | "google" | "dev"> {
  const out: Array<"github" | "google" | "dev"> = [];
  if (githubCredentials()) out.push("github");
  if (googleCredentials()) out.push("google");
  if (devAuthEnabled()) out.push("dev");
  return out;
}
