/**
 * The arena feed — `SPEC.md#7`.
 *
 * Sits under the rating board because that is where the drama is: `#4.1` gives
 * titles, seasons and elimination to rating alone, so a usurping only means
 * something in that context.
 *
 * Entry text is rendered server-side by `arenaFeed()` under the arena's
 * visibility rules; this component never touches a handle directly.
 */

import { arenaFeed, formatDuration, getDb } from "@usurp/db";

function ago(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  const d = formatDuration(seconds);
  return d === "just now" ? d : `${d} ago`;
}

/** A glyph per event type, so the feed scans without reading every line. */
const GLYPHS: Record<string, string> = {
  usurped: "⚔",
  crowned: "♛",
};

export default async function FeedView({ slug }: { slug: string }) {
  const feed = await arenaFeed(getDb(), slug, { limit: 12 });
  if (!feed || feed.entries.length === 0) return null;

  return (
    <>
      <h2 className="section">Feed</h2>
      <ul className="feed">
        {feed.entries.map((entry) => (
          <li key={entry.id}>
            <span className={`glyph ${entry.type}`}>{GLYPHS[entry.type] ?? "•"}</span>
            <span className="feed-text">{entry.text}</span>
            <span className="sub feed-when">{ago(entry.createdAt)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
