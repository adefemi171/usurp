/**
 * The rating board — `SPEC.md#4.1`'s actual league.
 *
 * This is where titles, seasons and (in M3) elimination live. `#4.1` is
 * explicit that they attach *only* here, which is why the Burn board next door
 * shows none of them: dressing volume up as achievement is the reskin failure
 * mode `#1` warns about.
 *
 * Reads `standings` via `ratingBoard()` rather than recomputing — `#6` calls
 * the board "the hottest read path".
 */

import {
  formatDuration,
  getDb,
  ratingBoard,
  TITLES,
  type BoardTitle,
} from "@usurp/db";
import InvitePrompt from "./invite-prompt";
import Avatar from "./avatar";
import { currentUser } from "../lib/session";
import type { TrustFilter } from "./board-nav";

function usd(points: number): string {
  return points.toLocaleString();
}

/** Rank movement since the last recompute. */
function movement(value: number | null): React.ReactNode {
  if (value === null) return <span className="sub">new</span>;
  if (value === 0) return <span className="sub">—</span>;
  const up = value > 0;
  return (
    <span className={up ? "move up" : "move down"}>
      {up ? "▲" : "▼"} {Math.abs(value)}
    </span>
  );
}

function TitleBadge({ title }: { title: BoardTitle | undefined }) {
  if (!title) return null;
  const copy = TITLES[title];
  return (
    <span className={`title-badge ${title}`} title={copy.blurb}>
      {copy.label}
    </span>
  );
}

function daysLeft(endsAt: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 86_400_000));
}

export default async function RatingView({
  slug,
  trust,
}: {
  slug: string;
  trust?: TrustFilter;
}) {
  const viewer = await currentUser();
  const board = await ratingBoard(getDb(), slug, {
    limit: 100,
    trust,
    ...(viewer ? { viewerId: viewer.id } : {}),
  });

  if (!board) {
    return (
      <div className="empty">
        <h2>No such arena</h2>
        <p>
          Nothing is registered at <code>{slug}</code>.
        </p>
      </div>
    );
  }

  const scored = board.rows.filter((r) => r.points > 0);

  // A board of one is a mirror, not a league. Show the invite code instead —
  // and note this is keyed on `memberCount`, not on visible rows, so an arena
  // where everyone else is hidden does not get told to invite people.
  if (board.memberCount <= 1) {
    return (
      <InvitePrompt
        arenaName={board.arena.name}
        arenaType={board.arena.type}
        inviteCode={board.inviteCode}
        memberCount={board.memberCount}
        {...(viewer
          ? { profileHref: "/u/" + encodeURIComponent(viewer.handle) }
          : {})}
      />
    );
  }

  return (
    <>
      <p className="season-bar">
        <strong>Season {board.season.idx}</strong>
        <span className="sub">
          {" "}
          · {daysLeft(board.season.endsAt)} days left
        </span>
        {board.throne && (
          <>
            <span className="sep">·</span>
            {/* `#5.1` tracks reign length because that is the tension: a
                board showing only who is first cannot say whether they are
                entrenched or just arrived. */}
            <span className="throne-state">
              <span className="glyph crowned">♛</span>{" "}
              {board.throne.display ?? "Someone"} has held the Throne{" "}
              <strong>{formatDuration(board.throne.heldSeconds)}</strong>
            </span>
          </>
        )}
      </p>

      {scored.length === 0 ? (
        <div className="empty">
          <h2>No rating yet this season</h2>
          <p>
            {board.total === 0
              ? "This arena has no visible members."
              : `${board.total} member${board.total === 1 ? "" : "s"}, none with points yet.`}
          </p>
          <p style={{ marginTop: 14 }}>
            Ratings are rebuilt from synced usage. If you have synced, the
            recompute may not have run yet:
          </p>
          <p>
            The hosted worker normally updates ratings every ten minutes while
            the service is awake. Historical and manual imports remain
            analytics-only.
          </p>
        </div>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Rating standings"
          tabIndex={0}
        >
          <table className="board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Title</th>
                <th scope="col">Who</th>
                <th scope="col">Points</th>
                <th scope="col">Moved</th>
                <th scope="col">Trust</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((row) => (
                <tr
                  key={`${row.rank}-${row.handle ?? row.pseudonym}`}
                  className={
                    [
                      row.title === "sovereign" ? "throne" : "",
                      row.rank <= 3 && !row.eliminated ? "top3" : "",
                      // `#5.2` — "greyed as out". Still listed, still accruing.
                      row.eliminated ? "eliminated" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                >
                  <td className="rank">{row.rank}</td>
                  <td>
                    {row.eliminated && (
                      <span
                        className="badge out"
                        title="Eliminated from title contention this season. Still accruing."
                      >
                        out
                      </span>
                    )}
                    <TitleBadge title={row.title} />
                    {row.title === "sovereign" && board.throne && (
                      <span
                        className="held"
                        title={`Since ${board.throne.startedAt.toISOString()}`}
                      >
                        held {formatDuration(board.throne.heldSeconds)}
                      </span>
                    )}
                  </td>
                  <td className="who">
                    <span className="who-cell">
                      {/* Top three get a larger avatar — the only place the
                        board leans on hierarchy, and only on rating, where a
                        position is earned rather than bought. */}
                      <Avatar
                        url={row.avatarUrl}
                        name={row.handle ?? row.pseudonym ?? "?"}
                        size={row.rank <= 3 ? 34 : 26}
                      />
                      {row.pseudonym ? (
                        <span className="anon">{row.pseudonym}</span>
                      ) : (
                        // The handle, not the display name: it is the canonical
                        // identity, it is what `/u/<handle>` resolves, and
                        // showing one while linking to the other invites "who is
                        // this?" every time someone sets a display name.
                        <a
                          className="who-link"
                          href={`/u/${encodeURIComponent(row.handle!)}`}
                        >
                          {row.handle}
                        </a>
                      )}
                    </span>
                  </td>
                  <td className="num">{usd(row.points)}</td>
                  <td className="num">
                    {movement(row.prevRank === null ? null : row.movement)}
                  </td>
                  <td>
                    <span
                      className={row.underReview ? "badge flagged" : "badge"}
                    >
                      {row.underReview
                        ? "Under review"
                        : row.trustTier.replaceAll("_", " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer>
        <p>
          Applied and reverted edits depend on what each tool records. Claude
          Code reversions are inferred from declined or failed edits; Copilot
          records explicit undo events. Missing telemetry is not treated as
          failure.
        </p>
        <p>
          <strong>Points</strong> are <code>volume × efficiency × streak</code>,
          with volume log-scaled so 10x the tokens is only +10 points. Seasonal
          points decay 5% for every day you are inactive — standing still is
          falling.
        </p>
        <p>
          The <strong>Sovereign</strong> holds the Throne and loses it the
          moment someone plays better. The <strong>Usurper</strong> is next in
          line, waiting for exactly that.
        </p>
      </footer>
    </>
  );
}
