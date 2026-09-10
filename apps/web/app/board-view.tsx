/**
 * The Burn board, rendered server-side straight from the database.
 *
 * No client-side fetch and no API hop: this is a server component, so the page
 * runs the same `burnBoard()` query the JSON endpoint does. `#8` picks Next
 * partly for this — one deploy serves both the board and the API.
 */

import { burnBoard, getDb, type BoardWindow, type BurnRow } from "@usurp/db";
import InvitePrompt from "./invite-prompt";
import Avatar from "./avatar";
import { currentUser } from "../lib/session";
import type { TrustFilter } from "./board-nav";

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000)
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars >= 1000) return `$${Math.round(dollars).toLocaleString()}`;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  return `$${dollars.toFixed(4)}`;
}

function name(row: BurnRow): React.ReactNode {
  // An anonymous member is deliberately not a link: `/u/<handle>` 404s for
  // them, and rendering a dead link would suggest a profile exists to find.
  if (row.pseudonym) return <span className="anon">{row.pseudonym}</span>;
  if (!row.handle) return row.displayName ?? "—";
  return (
    <a className="who-link" href={`/u/${encodeURIComponent(row.handle)}`}>
      {row.displayName ?? row.handle}
    </a>
  );
}

export default async function BoardView({
  slug,
  window,
  trust,
}: {
  slug: string;
  window: BoardWindow;
  trust?: TrustFilter;
}) {
  const viewer = await currentUser();
  const board = await burnBoard(getDb(), slug, {
    window,
    trust,
    limit: 100,
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

  const hasRows = board.rows.some((r) => r.effectiveTokens > 0);

  // Same rule as the rating board: a solo arena needs people, not a ranking.
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
      {!hasRows ? (
        <div className="empty">
          <h2>Nothing here yet</h2>
          <p>
            {board.total === 0
              ? "This arena has no visible members."
              : `${board.total} member${board.total === 1 ? "" : "s"}, no usage in this window.`}
          </p>
          <p style={{ marginTop: 16 }}>To put yourself on it:</p>
          <ol>
            <li>
              <a href="/signin">Sign in or create your profile</a>
            </li>
            <li>
              In Settings, choose <a href="/connect">Connect this computer</a>.
            </li>
            <li>
              Approve the device and sync with Usurp Connect. Join this arena
              when you are ready to compete.
            </li>
          </ol>
        </div>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Burn standings"
          tabIndex={0}
        >
          <table className="board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Who</th>
                <th scope="col">Effective</th>
                <th scope="col">Output</th>
                <th scope="col">Cache read</th>
                <th scope="col">Calls</th>
                <th scope="col">Est. cost</th>
                <th scope="col">Trust</th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((row) => (
                <tr key={`${row.rank}-${row.handle ?? row.pseudonym}`}>
                  <td className="rank">{row.rank}</td>
                  <td className="who">
                    <span className="who-cell">
                      {/* Uniform size on Burn. `#4.1` gives hierarchy to rating
                        only — enlarging the top spender would dress volume up
                        as achievement. */}
                      <Avatar
                        url={row.avatarUrl}
                        name={row.handle ?? row.pseudonym ?? "?"}
                        size={26}
                      />
                      {name(row)}
                    </span>
                  </td>
                  <td
                    className="num"
                    title={row.effectiveTokens.toLocaleString()}
                  >
                    {compact(row.effectiveTokens)}
                  </td>
                  <td className="num" title={row.outputTokens.toLocaleString()}>
                    {compact(row.outputTokens)}
                  </td>
                  <td
                    className="num sub"
                    title={row.cacheReadTokens.toLocaleString()}
                  >
                    {compact(row.cacheReadTokens)}
                  </td>
                  <td className="num sub">{row.calls.toLocaleString()}</td>
                  <td className="cost">{usd(row.costMicros)}</td>
                  <td>
                    <span className={row.flagged ? "badge flagged" : "badge"}>
                      {row.flagged
                        ? "flagged"
                        : row.trustTier.replace("_", " ")}
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
          <strong>Effective</strong> is input + output + cache&nbsp;write.
          Cache&nbsp;reads are shown separately because they are ~10% of the
          input rate — counting them as volume is what rewards waste.
        </p>
        <p>
          Cost is a comparison estimate, not an invoice. Unknown pricing is
          incomplete, not free usage. Preferred AgentsView totals appear on your
          usage profile.
        </p>
        <p>
          Only aggregate hourly counters leave your machine. No prompts, code,
          file paths, repo names, or session ids — ever.
        </p>
      </footer>
    </>
  );
}
