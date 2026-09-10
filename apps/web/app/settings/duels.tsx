"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Duel = {
  id: string;
  arenaId: string;
  metric: string;
  wagerPts: number;
  state: string;
  windowStart: string;
  windowEnd: string;
  window: string;
  opponent: { handle: string };
  isChallenger: boolean;
};
type Arena = { id: string; name: string };

export function Duels({
  initial,
  arenas,
}: {
  initial: Duel[];
  arenas: Arena[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function post(path: string, body: unknown) {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || result.ok === false)
        throw new Error(result.failure || result.error || "Request failed");
      setNotice("Challenge updated.");
      router.refresh();
    } catch (error) {
      setNotice(
        (error instanceof Error ? error.message : "Request failed").replaceAll(
          "_",
          " ",
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" id="duels">
      <h2>Duels</h2>
      <p>
        Challenge a named member in one of your arenas. Wager earned rating
        points, not money. Both players must cover the stake; at most two
        challenges can be pending or active.
      </p>
      <p className="field-hint">
        Rating contests begin at the next UTC midnight; commits and edits begin
        at the next whole hour. The agreed 24-hour or 7-day window must finish
        within the season. Archive and manual imports do not count.
      </p>
      {arenas.length > 0 ? (
        <details>
          <summary>Challenge a member</summary>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void post("/v1/duels", {
                arena_id: data.get("arena"),
                opponent: String(data.get("opponent")).trim(),
                metric: data.get("metric"),
                wager_pts: Number(data.get("wager")),
                window: data.get("window"),
              });
            }}
          >
            <label className="field">
              Arena
              <select className="input" name="arena">
                {arenas.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Opponent’s public handle
              <input
                className="input"
                name="opponent"
                required
                minLength={2}
                maxLength={32}
              />
            </label>
            <label className="field">
              Metric
              <select className="input" name="metric">
                <option value="points">Rating points</option>
                <option value="commits">Commits</option>
                <option value="edits">Applied edits</option>
              </select>
            </label>
            <label className="field">
              Window
              <select className="input" name="window">
                <option value="24h">24 hours</option>
                <option value="7d">7 days</option>
              </select>
            </label>
            <label className="field">
              Rating points to wager
              <input
                className="input"
                type="number"
                name="wager"
                min={1}
                max={1000}
                step={1}
                defaultValue={10}
                required
              />
            </label>
            <button className="button" disabled={busy}>
              Send challenge
            </button>
          </form>
        </details>
      ) : (
        <p>
          Join an arena and earn rating points before challenging another
          member.
        </p>
      )}
      {initial.length === 0 ? (
        <p className="field-hint">No challenges yet.</p>
      ) : (
        initial.map((d) => (
          <article className="card" key={d.id}>
            <h3>
              {d.isChallenger ? "You challenged" : "Challenge from"}{" "}
              {d.opponent.handle}
            </h3>
            <p>
              {arenas.find((a) => a.id === d.arenaId)?.name ?? "Arena"} ·{" "}
              {d.metric} · {d.window} · {d.wagerPts} rating points · {d.state}
            </p>
            <p className="field-hint">
              {d.state === "proposed" ? "Reply before" : "Window ends"}{" "}
              {new Date(d.windowEnd)
                .toISOString()
                .replace("T", " ")
                .slice(0, 16)}{" "}
              UTC
            </p>
            {d.state === "proposed" && (
              <div className="row">
                {!d.isChallenger && (
                  <button
                    className="button"
                    disabled={busy}
                    onClick={() => void post(`/v1/duels/${d.id}/accept`, {})}
                  >
                    Accept challenge
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void post(`/v1/duels/${d.id}/decline`, {})}
                >
                  {d.isChallenger ? "Withdraw" : "Decline"}
                </button>
              </div>
            )}
          </article>
        ))
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
