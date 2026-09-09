/** The global arena's unfurl; arena cards themselves live in `a/[slug]`. */

import { GLOBAL_ARENA_SLUG } from "@usurp/db";
import { renderArenaCard } from "./a/[slug]/opengraph-image";

export const alt = "Usurp global arena standings";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function OpenGraphImage() {
  return renderArenaCard(GLOBAL_ARENA_SLUG);
}
