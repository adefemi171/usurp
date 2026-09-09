/**
 * The headline strip — the pattern Viberank leads with, adapted.
 *
 * Two deliberate differences from the reference:
 *
 *   **Cost is not the headline.** Viberank's hero leads on dollars burned, and
 *   `#4.1` is explicit that ranking on spend "rewards waste". Leading on it
 *   would make the front page an advertisement for the behaviour the product
 *   exists to stop. Cost is present, last, and labelled as an estimate.
 *
 *   **The lead figure is the Sovereign, not the biggest spender.** "X holds
 *   the Throne" is the sentence that makes someone want to take it; "Y burned
 *   the most" just tells them who has the largest budget.
 */

import { formatDuration, getDb, platformStats } from "@usurp/db";

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  if (n < 1_000_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  return `${(n / 1_000_000_000_000).toFixed(1)}T`;
}

function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}k`;
  return `$${dollars.toFixed(2)}`;
}

export default async function HeroStats({
  throne,
}: {
  /** The current Sovereign of the arena being viewed, if any. */
  throne?: { display: string | null; heldSeconds: number } | null;
}) {
  const stats = await platformStats(getDb());

  if (stats.competitors === 0) return null;

  return (
    <p className="hero">
      <span className="hero-item">
        <strong>{stats.competitors}</strong>{" "}
        {stats.competitors === 1 ? "competitor" : "competitors"}
      </span>
      <span className="hero-item">
        <strong>{compact(stats.effectiveTokens)}</strong> effective tokens
      </span>
      <span className="hero-item">
        <strong>{compact(stats.commits)}</strong> commits shipped
      </span>
      <span className="hero-item dim">
        <strong>{usd(stats.costMicros)}</strong> est. spend
      </span>
      {throne?.display && (
        <span className="hero-item throne-lead">
          <span className="glyph crowned">♛</span> {throne.display} holds the
          Throne <strong>{formatDuration(throne.heldSeconds)}</strong>
        </span>
      )}
    </p>
  );
}
