/**
 * `GET /v1/users/:handle` — the profile as JSON.
 *
 * Same query and the same visibility gate as the page, so the API cannot
 * accidentally become the way to read a profile the page refuses to render.
 */

import { z } from "zod";
import { derivedSignals, getDb, userProfile } from "@usurp/db";
import { NextResponse } from "next/server";

const querySchema = z.object({
  window: z.enum(["day", "week", "month", "all"]).default("week"),
});

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ handle: string }> },
): Promise<NextResponse> {
  const { handle } = await context.params;
  const url = new URL(request.url);

  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  let profile;
  try {
    profile = await userProfile(getDb(), decodeURIComponent(handle), {
      window: parsed.data.window,
      dailyAnalytics: true,
    });
  } catch (err) {
    console.error("profile query failed", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }

  if (!profile) {
    // Identical for absent, hidden, and anonymous users — see `profile.ts`.
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    handle: profile.handle,
    display_name: profile.displayName,
    avatar_url: profile.avatarUrl,
    trust_tier: profile.trustTier,
    flagged: profile.flagged,
    window: profile.window,
    device_count: profile.deviceCount,
    historical_buckets: profile.historicalBuckets,
    arenas: profile.arenas,
    first_seen: profile.firstSeen,
    last_seen: profile.lastSeen,
    totals: profile.totals,
    by_model: profile.byModel,
    by_model_agent: profile.byModelAgent,
    by_day: profile.byDay,
    by_agent: profile.byAgent,
    usage_series: profile.usageSeries,
    analytics_series: profile.analyticsSeries,
    bridge_series: profile.bridgeSeries,
    bridge_imports: profile.bridgeImports,
    accounting: { window: "UTC calendar days", totals: "native hourly counters", analytics_series: "preferred-source daily analytics" },
    // Labelled, so a consumer cannot mistake these for the M2 rating.
    signals: { ...derivedSignals(profile.totals), scored: false },
  });
}
