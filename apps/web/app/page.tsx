import BoardView from "./board-view";
import RatingView from "./rating-view";
import FeedView from "./feed-view";
import HeroStats from "./hero-stats";
import BoardNav, { parseMetric, parseWindow, parseTrust } from "./board-nav";
import { GLOBAL_ARENA_SLUG } from "@usurp/db";
import { currentUser } from "../lib/session";
import { baseUrl } from "../lib/env";
import ShareMenu from "./share-menu";
import LiveRefresh from "./live-refresh";
import Link from "next/link";
import NavigationPending from "./navigation-pending";
import { Suspense } from "react";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const metric = parseMetric(params.metric);
  const window = parseWindow(params.window);
  const trust = parseTrust(params.trust);
  const user = await currentUser();

  return (
    <main className="wrap home-page">
      <header className="home-hero">
        <div>
          <p className="eyebrow">
            <span className="status-dot" /> Your AI coding league
          </p>
          <h1>
            Make every
            <br />
            session <em>count.</em>
          </h1>
          <p className="hero-description">
            Understand your AI usage. Find your rhythm. Compete with your crew —
            on your terms.
          </p>
          <div className="hero-actions">
            <Link
              className="button"
              href={
                user
                  ? `/u/${encodeURIComponent(user.handle)}?window=all`
                  : "/signin"
              }
            >
              {user ? "Explore my usage" : "Get started"}{" "}
              <span aria-hidden="true">↗</span><NavigationPending />
            </Link>
            <a className="button secondary" href="#arena">
              Explore the arena <span aria-hidden="true">↓</span>
            </a>
          </div>
          <p className="hero-note">
            Your prompts stay private. Competing is always opt-in.
          </p>
        </div>
        <aside className="league-card" aria-label="How Usurp works">
          <div className="league-card-top">
            <span>THE WAY UP</span>
            <span aria-hidden="true">↗</span>
          </div>
          <h2>
            A little consistency.
            <br />A longer reign.
          </h2>
          <ol className="journey-list">
            <li>
              <span>01</span>
              <div>
                <strong>Connect your tools</strong>
                <p>Sync local coding activity from your device.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>See the whole picture</strong>
                <p>Explore tokens, models, and cost sources.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Make your move</strong>
                <p>Join an arena. Build a streak. Take the Throne.</p>
              </div>
            </li>
          </ol>
        </aside>
      </header>

      <div className="section-heading">
        <p className="eyebrow">Across the league</p>
        <span className="sub">Public competition · native activity</span>
      </div>
      <Suspense fallback={<p className="sub" role="status">Loading league totals…</p>}>
        <HeroStats />
      </Suspense>

      <section id="arena" className="arena-panel" aria-label="Global arena">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Open to everyone</p>
            <h2>Global arena</h2>
          </div>
          <a className="text-link" href="/settings#arenas">
            Manage arenas ↗
          </a>
        </div>
        <BoardNav
          metric={metric}
          window={window}
          trust={trust}
          anchor="#arena"
        />
        <LiveRefresh />
        {metric === "rating" ? (
          <p className="board-explainer">
            <strong>Rating rewards consistency.</strong> Seasonal points combine
            volume, efficiency, and streaks. This is where titles are earned.
          </p>
        ) : (
          <p className="board-explainer">
            <strong>Burn measures volume, not skill.</strong> Native usage
            counters and estimated cost. Choose Rating for seasonal competition.
          </p>
        )}

        {metric === "rating" && (
          <div className="share-line">
            <ShareMenu url={baseUrl()} text="Who holds the global Throne?" />
            <span>Shares a live, visibility-safe arena card.</span>
          </div>
        )}

        {/* Global is public. Keep these boundaries local: private arena/profile
            routes must finish authorization before sending a response. */}
        <Suspense key={`${metric}:${window}:${trust ?? "all"}`}
          fallback={<div className="empty" role="status" aria-live="polite">Loading {metric === "rating" ? "Rating" : "Burn"} standings…</div>}>
          {metric === "rating" ? <RatingView slug={GLOBAL_ARENA_SLUG} trust={trust} />
            : <BoardView slug={GLOBAL_ARENA_SLUG} window={window} trust={trust} />}
        </Suspense>
        {metric === "rating" && <Suspense fallback={null}>
          <FeedView slug={GLOBAL_ARENA_SLUG} />
        </Suspense>}
      </section>
      <section
        className="home-features"
        aria-label="Built around your workflow"
      >
        <article>
          <span className="feature-symbol" aria-hidden="true">
            ⌘
          </span>
          <h2>Your tools. One view.</h2>
          <p>
            Built-in readers for Codex, Cursor, and more. Optionally connect
            AgentsView for a shared usage snapshot.
          </p>
          <a className="text-link" href="/settings#devices">
            Connect a device ↗
          </a>
        </article>
        <article>
          <span className="feature-symbol" aria-hidden="true">
            ◎
          </span>
          <h2>Choose your audience.</h2>
          <p>
            Join the global league or a private club. Set your visibility for
            each arena, and leave whenever you like.
          </p>
          <a className="text-link" href="/settings#clubs">
            Find your crew ↗
          </a>
        </article>
      </section>
      <footer className="site-footer">
        <span className="app-logo">
          usurp<span>.</span>
        </span>
        <p>
          Activity, not your conversations. Only aggregate usage leaves your
          device.
        </p>
      </footer>
    </main>
  );
}
