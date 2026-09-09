import type { Metadata } from "next";
import BoardView from "../../board-view";
import RatingView from "../../rating-view";
import FeedView from "../../feed-view";
import HeroStats from "../../hero-stats";
import BoardNav, { parseMetric, parseWindow } from "../../board-nav";
import { baseUrl } from "../../../lib/env";
import ShareMenu from "../../share-menu";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const url = `${baseUrl()}/a/${encodeURIComponent(slug)}`;

  return {
    title: `Usurp — ${slug}`,
    description: "The live Usurp rating board. Hold the Throne, or lose it to someone playing better.",
    alternates: { canonical: url },
  };
}

export default async function ArenaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const metric = parseMetric(query.metric);
  const window = parseWindow(query.window);

  return (
    <main className="wrap">
      <header className="masthead">
        <div>
          <p className="eyebrow">Your competition</p>
          <h1 className="brand">
            Arena<span>.</span>
          </h1>
          <p className="tagline">
            <code>{slug}</code> · Find your place. Make your next move.
          </p>
        </div>
        <a className="tab" href="/">
          Global
        </a>
      </header>

      <HeroStats />

      <BoardNav metric={metric} window={window} />
      <p className="board-explainer">{metric === "rating" ? "Seasonal points combine volume, efficiency, and streaks. Titles are earned here." : "Burn measures volume, not skill. Cost is estimated from native usage; daily bridge snapshots appear on usage profiles."}</p>

      {metric === "rating" && (
        <div className="share-line">
          <ShareMenu
            url={`${baseUrl()}/a/${encodeURIComponent(slug)}`}
            text={`Who holds the Throne in ${slug}?`}
          />
          <span>Shares a live, visibility-safe arena card.</span>
        </div>
      )}

      {metric === "rating" ? (
        <>
          <RatingView slug={slug} />
          <FeedView slug={slug} />
        </>
      ) : (
        <BoardView slug={slug} window={window} />
      )}
    </main>
  );
}
