export const metadata = { title: "Privacy — Usurp" };

export default function PrivacyPage() {
  return (
    <main className="wrap">
      <header className="page-head">
        <div>
          <p className="eyebrow">YOUR USAGE. YOUR DATA.</p>
          <h1>Privacy commitments.</h1>
          <p>What Usurp collects, and what stays on your computer.</p>
        </div>
      </header>
      <section className="settings-section">
        <h2>Usage summaries, not your work</h2>
        <p>
          Local readers send hourly counters grouped by coding tool and model.
          The optional AgentsView bridge sends daily usage and cost summaries.
          Prompts, completions, code, file paths, project names, repository
          names, branches, session titles, and tool arguments are not uploaded.
        </p>
        <p>
          Device private keys stay in your operating system’s keychain. The
          server stores public keys, device labels, a random installation
          identifier, and signed summaries. An installation identifier is not a
          hardware fingerprint.
        </p>
      </section>
      <section className="settings-section">
        <h2>You choose where you appear</h2>
        <p>
          Browsing public boards does not require an account. Joining the global
          arena or a club is optional. You can leave each arena independently in
          Settings, or choose public, anonymous, or hidden visibility.
        </p>
        <p>
          Organization membership must be explicit. Organization administrators
          must not receive an individual member’s private usage through an
          aggregate report. Individual names are shown only when the member
          chooses public visibility in that arena.
        </p>
      </section>
      <section className="settings-section">
        <h2>Account and email information</h2>
        <p>
          GitHub sign-in supplies your account identifier and basic profile.
          Email sign-in stores your verified address as a login identity.
          Verification codes expire after ten minutes; only hashes are stored.
          Resend processes email delivery and retains delivery records according
          to its policies.
        </p>
        <p>
          Signing in never silently merges accounts or publishes your activity.
          Email notifications are optional and can be paused or removed.
        </p>
      </section>
      <section className="settings-section">
        <h2>Deletion and retention</h2>
        <p>
          Delete your account in Settings to remove the active database’s
          profile, identities, sessions, devices, usage counters, imported
          snapshots, repair copies, memberships, and notification channels.
          Other members’ accounts and shared clubs are not deleted. Historical
          event references are anonymized by removing your account identifiers.
        </p>
        <p>
          Encrypted backups are not rewritten immediately. They expire under the
          deployment operator’s backup-retention policy; an operator restoring a
          backup must reapply subsequent deletions before reopening access.
          Locally stored transcripts are controlled by you and are not erased by
          account deletion.
        </p>
      </section>
      <section className="settings-section">
        <h2>Costs and competition</h2>
        <p>
          Reported provider charges and historical API-rate estimates are
          different. Usurp labels the source of cost data and does not claim an
          estimate is your invoice. Missing usage is unavailable, not zero.
          Historical imports are excluded from rating, streaks, and duels.
        </p>
        <p>
          Late data can change current scores. Previously announced competitive
          events are not rewritten to manufacture a different history.
        </p>
      </section>
      <p>
        <a href="https://github.com/adefemi171/usurp">
          Inspect the MIT-licensed source
        </a>{" "}
        · <a href="/settings">Manage your data</a>
      </p>
    </main>
  );
}
