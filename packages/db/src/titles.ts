/**
 * Board titles — the narrative layer over `SPEC.md#5.1`.
 *
 * `#5.1` supplies the nouns already: #1 *holds the Throne*, a change of #1
 * closes a *reign* and emits a *dethroned* event. This file names the
 * positions consistently so the API, the UI, and the event feed cannot drift
 * into three different vocabularies.
 *
 * ── On the words ────────────────────────────────────────────────────────────
 * #1 is the SOVEREIGN, #2 is the USURPER, and `usurped` is the event when the
 * second takes the first.
 *
 * "Usurper" for #2 is a deliberate choice over the historically stricter
 * "Pretender". Strictly, a usurper has *already* seized the throne and a
 * pretender merely holds a claim — so "Pretender" is the more precise word for
 * a runner-up. It was rejected for two reasons that matter more than precision
 * on a leaderboard:
 *
 *   - **"Pretender" reads as "faker"** to a modern ear. It is a poor label for
 *     someone in second place who is, by definition, performing well.
 *   - **"Usurper" carries the threat**, and the threat is the product. "The
 *     Usurper is 40 points behind" is the sentence that makes a Sovereign log
 *     in; "the Pretender is 40 points behind" is not.
 *
 * The apparent collision with the `usurped` event is a feature rather than a
 * problem: the Usurper is the one who is going to usurp. The title names the
 * role, the event names the moment.
 *
 * One word stays rejected outright. **"Successor" for #1** is simply backwards
 * — a successor is whoever comes *after*. It does have a precise home: the
 * person who *ended* a reign is that reign's successor, which is
 * `reigns.ended_by_user_id`. It belongs in the history, not on the live board.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Title for a rank on the rating board. `undefined` for the unranked mass. */
export function titleForRank(
  rank: number,
  activeMembers: number,
): BoardTitle | undefined {
  // Two members are enough for a contest. Match the board's solo-arena gate;
  // requiring three hid both titles even while a two-member reign could run.
  if (activeMembers < 2 || rank < 1 || rank > activeMembers) return undefined;

  if (rank === 1) return "sovereign";
  if (rank === 2) return "usurper";
  // `#5.2` — the final four contest the reign, so the shortlist is named.
  if (rank <= 4) return "contender";
  return undefined;
}

export type BoardTitle = "sovereign" | "usurper" | "contender";

export interface TitleCopy {
  /** Short label for a badge. */
  label: string;
  /** One line explaining what the title means, for a tooltip. */
  blurb: string;
}

export const TITLES: Record<BoardTitle, TitleCopy> = {
  sovereign: {
    label: "Sovereign",
    blurb: "Holds the Throne. Loses it the moment someone plays better.",
  },
  usurper: {
    label: "Usurper",
    blurb: "Next in line, and one good week from taking the Throne.",
  },
  contender: {
    label: "Contender",
    blurb: "In the final four that contest the reign.",
  },
};

/**
 * Event types for the feed — `#6`'s append-only `events` log.
 *
 * `usurped` rather than `dethroned` as the primary name: the spec's word
 * describes what happened to the loser, this one describes what the actor did,
 * and an activity feed reads better in the active voice. `#5.1` promises a
 * notification to *both* parties, so the same event carries actor and target
 * and each side renders its own sentence.
 */
export const EVENT_USURPED = "usurped";
/** First #1 in an arena — nobody was dethroned, so it is not a usurping. */
export const EVENT_CROWNED = "crowned";

/** Feed copy for a usurping, from each side. */
export function usurpedCopy(
  actor: string,
  target: string,
): {
  feed: string;
  toActor: string;
  toTarget: string;
} {
  return {
    feed: `${actor} usurped the Throne from ${target}.`,
    toActor: `You took the Throne from ${target}. Hold it.`,
    // Deliberately not congratulatory or cruel — `#5` warns that a board which
    // pings all day gets muted, and gloating notifications get muted fastest.
    toTarget: `${actor} took the Throne. You are the Usurper now.`,
  };
}

export function crownedCopy(
  actor: string,
  arena: string,
): { feed: string; toActor: string } {
  return {
    feed: `${actor} is the first Sovereign of ${arena}.`,
    toActor: `You hold the Throne in ${arena}.`,
  };
}

/**
 * Compact human duration, e.g. "3d", "5h", "12m".
 *
 * Shared so a reign reads the same length wherever it appears — the board, the
 * feed and the hall of fame disagreeing about how long someone has held the
 * Throne would undermine the one number the product is about.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
