import { availableProviders, devAuthEnabled, emailAuthEnabled } from "../../lib/env";
import { EmailForm } from "./email-form";
import { currentUser } from "../../lib/session";
import { redirect } from "next/navigation";
import { safeReturnTo } from "../../lib/return-to";

const LABELS: Record<string, string> = {
  github: "Sign in with GitHub",
  dev: "Developer sign-in (local only)",
};

/** Messages for the `error` codes the callback redirects back with. */
const ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  provider_error: "The provider reported an error. Try again.",
  missing_code: "The provider did not return an authorization code.",
  invalid_state:
    "That sign-in attempt could not be verified. It may have expired — start again.",
  exchange_failed: "Could not complete sign-in with the provider. Try again.",
  signin_failed: "Something went wrong creating your account. Try again.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (await currentUser()) redirect(typeof params.return_to === "string" ? safeReturnTo(params.return_to) : "/settings");
  const error = typeof params.error === "string" ? params.error : undefined;
  const returnTo = typeof params.return_to === "string" ? params.return_to : undefined;
  const providers: string[] = availableProviders();

  const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";

  return (
    <main className="wrap auth-layout">
      <div className="auth-story">
        <p className="eyebrow">Your next chapter</p>
        <h1>Good to have<br />you <span>here.</span></h1>
        <p>A home for your AI coding activity. See what you use, find your people, and build your own momentum.</p>
        <ul><li>Your conversations stay on your device</li><li>You choose where you compete</li><li>One view across your coding tools</li></ul>
      </div>
      <div>

      {error && (
        <p className="disclaimer error" role="alert">
          {ERRORS[error] ?? "Sign-in failed. Try again."}
        </p>
      )}

      <section className="signin-card" aria-label="Sign in options">
        <h2>Welcome to Usurp</h2>
        <p>Sign in or create your account to get started.</p>
        <div className="stack">
          {providers.map((id) => (
            <a
              key={id}
              className="button secondary"
              href={`/auth/${id}${query}`}
            >
              {id === "github" ? <svg className="provider-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.84c.85 0 1.71.12 2.51.34 1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.73c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg> : <span className="provider-icon" aria-hidden="true">{id === "google" ? "G" : "⌘"}</span>}
              {LABELS[id] ?? id}
            </a>
          ))}
        </div>
        {providers.length === 0 && (
          <p className="field-hint">
            GitHub sign-in is not configured on this deployment.
          </p>
        )}
        <p className="auth-note">Signing in never joins a public board automatically. You decide what to share in Settings.</p>
        {emailAuthEnabled() ? <div className="auth-options"><p>Or use your email address</p><EmailForm returnTo={returnTo} /></div> : <p className="field-hint">Email sign-in will be available once this deployment’s email sender is configured.</p>}
        <p className="field-hint">Already use GitHub? Continue with GitHub, then link your email in Settings to keep one account.</p>
      </section>

      {devAuthEnabled() && (
        <p className="disclaimer">
          <strong>Developer sign-in is enabled.</strong> It performs no
          authentication and requires <code>USURP_DEV_AUTH=1</code> with a
          non-production <code>NODE_ENV</code>. Never enable it on a real
          deployment.
        </p>
      )}

      </div>
    </main>
  );
}
