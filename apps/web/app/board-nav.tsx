/**
 * Metric and window switchers, shared by both boards.
 *
 * `#4.1` requires the two boards be "honestly labelled" — Burn is volume,
 * Rating is the league. A single toggle that names both is the clearest way to
 * keep that distinction in front of the reader rather than in a footnote.
 *
 * The window switcher is hidden on the rating board: a rating is scoped to a
 * *season*, not an arbitrary trailing window, and offering "24 hours" there
 * would imply a 24-hour rating exists.
 */

import type { BoardWindow } from "@usurp/db";

export type BoardMetric = "burn" | "rating";

const WINDOWS: Array<{ key: BoardWindow; label: string }> = [
  { key: "day", label: "24 hours" },
  { key: "week", label: "7 days" },
  { key: "month", label: "30 days" },
  { key: "all", label: "All time" },
];

export function parseMetric(value: string | string[] | undefined): BoardMetric {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "rating" ? "rating" : "burn";
}

export function parseWindow(value: string | string[] | undefined): BoardWindow {
  const raw = Array.isArray(value) ? value[0] : value;
  const allowed = new Set<BoardWindow>(["day", "week", "month", "all"]);
  return raw && allowed.has(raw as BoardWindow) ? (raw as BoardWindow) : "week";
}

export default function BoardNav({
  metric,
  window,
  anchor = "",
}: {
  metric: BoardMetric;
  window: BoardWindow;
  anchor?: string;
}) {
  return (
    <div className="board-controls">
      <nav className="controls" aria-label="Board">
        <a
          className="tab"
          href={`?metric=rating${anchor}`}
          aria-current={metric === "rating" ? "true" : undefined}
        >
          Rating
        </a>
        <a
          className="tab"
          href={`?metric=burn&window=${window}${anchor}`}
          aria-current={metric === "burn" ? "true" : undefined}
        >
          Burn
        </a>
        {/* `#5.1` — a second axis to compete on, so being dethroned still
            leaves a record. Reachable from the board it matters on. */}
      </nav>

      {metric === "burn" && (
        <nav className="controls" aria-label="Window">
          {WINDOWS.map((w) => (
            <a
              key={w.key}
              className="tab small"
              href={`?metric=burn&window=${w.key}${anchor}`}
              aria-current={w.key === window ? "true" : undefined}
            >
              {w.label}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
