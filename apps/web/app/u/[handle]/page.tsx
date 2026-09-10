import { notFound } from "next/navigation";
import { efficiencyFeedback, getDb, userProfile, type BoardWindow } from "@usurp/db";
import { eq } from "drizzle-orm";
import UsageDashboard from "./usage-dashboard";
import styles from "./dashboard.module.css";
import { currentUser } from "../../../lib/session";
import { ownedBridge } from "../../../lib/bridge";

export const metadata = { title: "Usage overview — Usurp" };

export default async function UserPage({ params, searchParams }: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ handle }, query] = await Promise.all([params, searchParams]);
  const raw = Array.isArray(query.window) ? query.window[0] : query.window;
  const window: BoardWindow = raw === "all" || raw === "day" || raw === "month" ? raw : "week";
  // A trusted session allows self-access without making the profile public.
  // All other visitors still pass the membership gate before analytics load.
  const viewer = await currentUser();
  const profile = await userProfile(getDb(), decodeURIComponent(handle), {
    window, dailyAnalytics: true, ...(viewer ? { viewerId: viewer.id } : {}),
  });
  if (!profile) notFound();
  const isOwner = viewer?.handle?.toLowerCase() === profile.handle.toLowerCase();
  const canRefreshSource = !!(isOwner && viewer && await ownedBridge(viewer.id));
  const feedback = isOwner && viewer ? await getDb().select({ recommendation: efficiencyFeedback.recommendation, response: efficiencyFeedback.response }).from(efficiencyFeedback).where(eq(efficiencyFeedback.userId, viewer.id)) : [];
  return <main className={styles.dashboard}>
    <header className={styles.header}>
      <div className={styles.identity}>
        <div><p className="eyebrow">Your activity, in focus</p><h1>Usage overview<span className={styles.headingDot}>.</span></h1><p>{profile.displayName ?? profile.handle} <span> / @{profile.handle}</span></p></div>
      </div>
      <div className={styles.headerActions}>
        <span className={styles.signed}><i />{profile.trustTier.replaceAll("_", " ")}</span>
        {isOwner ? <a href="/settings" className={styles.linkButton}>Data & settings</a> : !viewer ? <a href="/signin" className={styles.linkButton}>Sign in</a> : null}
      </div>
    </header>
    <UsageDashboard key={window} rows={profile.analyticsSeries} bridgeRows={profile.bridgeSeries} nativeRows={profile.usageSeries} window={window} flagged={profile.flagged}
      bridgeImports={profile.bridgeImports} canRefreshSource={canRefreshSource} isOwner={isOwner}
      deviceCount={profile.deviceCount} lastSeen={profile.lastSeen?.toISOString() ?? null} feedback={feedback} />
    <footer className={styles.footer}>
      <span>YOUR USAGE. YOUR DATA.</span>
      <p>Aggregate usage only: hourly native records and optional daily <a href="https://github.com/kenn-io/agentsview" target="_blank" rel="noopener noreferrer">AgentsView snapshots ↗</a>. Usurp does not collect project names, session titles, prompts, or code.
        Historical imports remain excluded from ratings, streaks, and duels.</p>
      <details><summary>Import older activity</summary><p>From your source folder, run <code>npm run usurp -- sync --all</code>, then select All time.</p></details>
    </footer>
  </main>;
}
