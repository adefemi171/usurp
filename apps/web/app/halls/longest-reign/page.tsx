/**
 * `/halls/longest-reign` — `SPEC.md#5.1`.
 *
 * The second axis to compete on. A dethroned Sovereign keeps their record here,
 * which is what stops the top of the board being a pure churn machine: you can
 * lose the Throne and still have held it longest.
 */

import { getDb, longestReigns } from "@usurp/db";
import { currentUser } from "../../../lib/session";
import Link from "next/link";
import NavigationPending from "../../navigation-pending";

/**
 * Required, unlike the other pages.
 *
 * Every other page is forced dynamic implicitly by reading `params`,
 * `searchParams`, or `cookies()`. This one takes no request-scoped input and
 * only touches the database, so Next classifies it as static and tries to
 * prerender it at build time — which fails with "DATABASE_URL is not set",
 * because a build has no database. It is also live data that must never be
 * baked into the bundle.
 */
export const dynamic = "force-dynamic";

function span(days: number): string {
  if (days < 1) return "under a day";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export default async function LongestReignPage() {
  const rows = await longestReigns(getDb(), {
    limit: 50,
    viewerId: (await currentUser())?.id,
  });

  return (
    <main className="wrap">
      <header className="masthead">
        <div>
          <p className="eyebrow">Hall of fame</p>
          <h1 className="brand">
            Longest Reign<span>.</span>
          </h1>
          <p className="tagline">
            Permanent, across every arena and every season. Being dethroned
            still leaves a record.
          </p>
        </div>
        <Link className="tab" href="/">
          ← Board<NavigationPending />
        </Link>
      </header>
      <div className="reign-intro">
        <span aria-hidden="true">♛</span>
        <div>
          <h2>The Throne changes hands. The record stays.</h2>
          <p>
            The longest reigns across every arena and season, including those
            still in progress.
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <h2>No reigns yet</h2>
          <p>
            A reign begins the first time someone takes rank one in an arena
            with points on the board.
          </p>
        </div>
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Longest reigns"
          tabIndex={0}
        >
          <table className="board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Holder</th>
                <th scope="col">Arena</th>
                <th scope="col">Held</th>
                <th scope="col">Peak</th>
                <th scope="col">Ended by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.arena.slug}-${r.startedAt.toISOString()}`}
                  className={r.open ? "throne" : undefined}
                >
                  <td className="rank">{i + 1}</td>
                  <td className="who">
                    {r.holder.handle ? (
                      <Link
                        className="who-link"
                        href={`/u/${encodeURIComponent(r.holder.handle)}`}
                      >
                        {r.holder.handle}
                      </Link>
                    ) : (
                      <span className="anon">{r.holder.pseudonym}</span>
                    )}
                  </td>
                  <td className="sub">
                    <Link
                      className="who-link"
                      href={`/a/${r.arena.slug}?metric=rating`}
                    >
                      {r.arena.name}
                    </Link>
                  </td>
                  <td className="num">
                    {span(r.days)}
                    {r.open && (
                      <span className="title-badge sovereign reigning">
                        reigning
                      </span>
                    )}
                  </td>
                  <td className="num sub">{r.peakPoints.toLocaleString()}</td>
                  <td className="sub">
                    {r.open ? "—" : (r.endedBy?.display ?? "unknown")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer>
        <p>
          A reign runs from taking rank one until someone takes it back. Open
          reigns are measured to now, so the current Sovereign of each arena is
          still climbing this board.
        </p>
      </footer>
    </main>
  );
}
