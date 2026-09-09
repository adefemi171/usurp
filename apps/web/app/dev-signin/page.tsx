/**
 * The dev provider's "authorization server".
 *
 * Stands in for GitHub/Google consent so the rest of M1 is testable without
 * registered OAuth apps. Returns 404 unless `devAuthEnabled()` — that is
 * `NODE_ENV !== production` **and** `USURP_DEV_AUTH=1`.
 *
 * The form is a plain GET to the real callback, so the flow exercises the same
 * state-cookie validation and session issuance the live providers do. No
 * client-side JavaScript, and no separate code path to keep in sync.
 */

import { notFound } from "next/navigation";
import { devAuthEnabled } from "../../lib/env";

export default async function DevSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!devAuthEnabled()) notFound();

  const params = await searchParams;
  const state = typeof params.state === "string" ? params.state : "";

  return (
    <main className="wrap">
      <header className="masthead">
        <div>
          <h1 className="brand">
            Dev sign-in<span>.</span>
          </h1>
          <p className="tagline">
            Local stand-in for GitHub / Google. Any handle signs you in as that
            account; the same handle is always the same account.
          </p>
        </div>
      </header>

      <p className="disclaimer">
        <strong>Development only.</strong> This page requires{" "}
        <code>USURP_DEV_AUTH=1</code> and a non-production{" "}
        <code>NODE_ENV</code>. It performs no authentication whatsoever.
      </p>

      {!state ? (
        <div className="empty">
          <h2>Missing state</h2>
          <p>
            Start from <a href="/auth/dev">/auth/dev</a> so the flow gets its
            signed state cookie.
          </p>
        </div>
      ) : (
        <form className="form" method="GET" action="/auth/dev/callback">
          {/* Round-trips the state so the callback validates exactly as a real
              provider's redirect would. */}
          <input type="hidden" name="state" value={state} />
          <label className="field">
            <span className="field-label">Handle</span>
            <input
              className="input"
              type="text"
              name="code"
              placeholder="kenn"
              defaultValue="kenn"
              required
              minLength={2}
              maxLength={32}
              pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
              autoFocus
            />
            <span className="field-hint">
              Letters, digits, <code>_</code> and <code>-</code>. Becomes the
              provider identity <code>dev:&lt;handle&gt;</code>.
            </span>
          </label>
          <button className="button" type="submit">
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}
