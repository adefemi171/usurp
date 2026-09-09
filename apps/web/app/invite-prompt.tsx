/**
 * What a solo arena shows instead of a board.
 *
 * A leaderboard of one is not a leaderboard — it is a mirror. `#2` caps clubs
 * at 50 and makes them invite-only, so the useful thing to show the first
 * member is the invite code, not their own name in position one.
 *
 * Deliberately distinct from the "no activity yet" state. Those are different
 * problems with different fixes: one needs people, the other needs a sync.
 */

export default function InvitePrompt({
  arenaName,
  arenaType,
  inviteCode,
  memberCount,
  profileHref,
}: {
  arenaName: string;
  arenaType: "global" | "org" | "club";
  /** Owner only — null for everyone else. */
  inviteCode: string | null;
  memberCount: number;
  /** Current viewer's public usage profile, when one is available. */
  profileHref?: string;
}) {
  const solo = memberCount <= 1;

  return (
    <div className="empty">
      <h2>{solo ? "Every league starts with a crew" : arenaName}</h2>

      <p>
        {solo
          ? `${arenaName} is waiting for its next competitor. Invite your crew to get the competition going.`
          : `${memberCount} members, but nobody has synced usage yet.`}
      </p>

      {profileHref && (
        <p style={{ marginTop: 16 }}>
          Explore your own activity while the arena grows.{" "}
          <a className="button secondary" href={profileHref}>
            View your usage breakdown
          </a>
        </p>
      )}

      {inviteCode ? (
        <>
          <p style={{ marginTop: 16 }}>
            Share this code — they enter it at{" "}
            <a className="who-link" href="/settings">
              Settings → Clubs → Join with a code
            </a>
            :
          </p>
          <pre>
            <code>{inviteCode}</code>
          </pre>
          <p className="field-hint">
            Case, spaces and dashes are ignored. Rotate it from Settings if it
            leaks.
          </p>
        </>
      ) : arenaType === "club" ? (
        <p style={{ marginTop: 16 }}>
          Ask the club owner for the invite code — only they can share it.
        </p>
      ) : arenaType === "org" ? (
        <p style={{ marginTop: 16 }}>
          Org arenas fill up through domain verification rather than invite
          codes.
        </p>
      ) : (
        <p style={{ marginTop: 16 }}>
          Global membership is opt-in, so it fills as people choose to compete.
        </p>
      )}

      {/* Titles need three people to mean anything — say so, so the absence of
          a Sovereign badge in a two-person club is not read as a bug. */}
      {memberCount === 2 && (
        <p className="field-hint" style={{ marginTop: 14 }}>
          One more member and titles unlock — Sovereign, Usurper, Contender.
        </p>
      )}
    </div>
  );
}
