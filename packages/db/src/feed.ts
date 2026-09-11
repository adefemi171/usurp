/**
 * Arena feed and the Longest Reign hall of fame — `SPEC.md#7`, `#5.1`.
 *
 * ── The privacy trap ────────────────────────────────────────────────────────
 * A feed entry is a sentence about two people: "X usurped the Throne from Y."
 * `#2` lets a member compete `anonymous` — named by a stable pseudonym at their
 * true rank — or `hidden` entirely. A feed that resolved `actor_id` straight to
 * a handle would undo both, and it would do so *retroactively*: every past
 * event would leak the identity of someone who has since gone anonymous.
 *
 * So names are resolved through the actor's **current visibility in that
 * arena**, not through `users.handle`. A hidden member's events are dropped
 * from the feed altogether; an anonymous member gets their pseudonym.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { arenaMembers, arenas, events, reigns, users } from "./schema.js";
import { pseudonymFor } from "./board.js";
import { EVENT_CROWNED, EVENT_USURPED } from "./titles.js";

/** How a person may be named in public copy. */
export interface FeedActor {
  /** Null when anonymous. */
  handle: string | null;
  /** Set when anonymous. */
  pseudonym: string | null;
  /** Whichever of the two should be rendered. */
  display: string;
}

export interface FeedEntry {
  id: string;
  type: string;
  createdAt: Date;
  actor: FeedActor | null;
  target: FeedActor | null;
  /** Rendered sentence, already visibility-safe. */
  text: string;
  payload: Record<string, unknown>;
}

export interface FeedOptions {
  limit?: number;
  /** Cursor: return entries strictly older than this. */
  before?: Date;
}

/**
 * Resolve a user to a display name under an arena's visibility rules.
 *
 * Returns `undefined` for a hidden member or a non-member, which the caller
 * treats as "drop this entry".
 */
export function resolveActor(
  userId: string | null,
  members: Map<string, { handle: string; visibility: string; status: string }>,
): FeedActor | null | undefined {
  if (!userId) return null;

  const member = members.get(userId);
  // A user who left, or was never a member, is not named — their events stay
  // in the log (`#6.2` is append-only) but are not rendered here.
  if (!member || member.status === "left") return undefined;
  if (member.visibility === "hidden") return undefined;

  if (member.visibility === "anonymous") {
    const pseudonym = pseudonymFor(userId);
    return { handle: null, pseudonym, display: pseudonym };
  }
  return { handle: member.handle, pseudonym: null, display: member.handle };
}

/** Sentence for an event, in the active voice. */
function renderEntry(
  type: string,
  actor: FeedActor | null,
  target: FeedActor | null,
  arenaName: string,
): string {
  const who = actor?.display ?? "Someone";

  switch (type) {
    case EVENT_USURPED:
      return `${who} usurped the Throne from ${target?.display ?? "the previous Sovereign"}.`;
    case EVENT_CROWNED:
      return `${who} is the first Sovereign of ${arenaName}.`;
    default:
      // Unknown types are rendered rather than hidden: `#6` makes `events` the
      // single log behind the feed, notifications *and* the audit trail, so a
      // type added by a later milestone must not silently vanish from the feed.
      return `${who} — ${type.replace(/_/g, " ")}.`;
  }
}

export interface ArenaFeed {
  arena: { slug: string; name: string; type: "global" | "org" | "club" };
  entries: FeedEntry[];
  /** Cursor for the next page, or null at the end. */
  nextBefore: Date | null;
}

/**
 * The visibility map for one arena: `user_id` → how they may be named.
 *
 * Exported because notifications must resolve names the *same* way the feed
 * does. Two copies of this rule would drift, and the drift would be a privacy
 * regression rather than a cosmetic one.
 */
export async function arenaVisibility(
  db: Db,
  arenaId: string,
): Promise<
  Map<string, { handle: string; visibility: string; status: string }>
> {
  const rows = await db
    .select({
      userId: arenaMembers.userId,
      handle: users.handle,
      visibility: arenaMembers.visibility,
      status: arenaMembers.status,
    })
    .from(arenaMembers)
    .innerJoin(users, eq(users.id, arenaMembers.userId))
    .where(eq(arenaMembers.arenaId, arenaId));

  return new Map(rows.map((m) => [m.userId, m]));
}

export async function arenaFeed(
  db: Db,
  slug: string,
  options: FeedOptions = {},
): Promise<ArenaFeed | undefined> {
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);

  const [arena] = await db
    .select()
    .from(arenas)
    .where(eq(arenas.slug, slug))
    .limit(1);
  if (!arena) return undefined;

  const conditions = [eq(events.arenaId, arena.id)];
  if (options.before) conditions.push(lt(events.createdAt, options.before));

  // Over-fetch, because entries naming a hidden member are dropped after the
  // query and would otherwise short the page.
  const rowsQuery = db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.createdAt))
    .limit(limit * 3);

  const [members, rows] = await Promise.all([
    arenaVisibility(db, arena.id),
    rowsQuery,
  ]);

  const entries: FeedEntry[] = [];

  for (const row of rows) {
    if (entries.length >= limit) break;

    const actor = resolveActor(row.actorId, members);
    const target = resolveActor(row.targetId, members);

    // `undefined` means "hidden or gone" — drop the whole entry rather than
    // render a half-anonymous sentence that invites guessing.
    if (actor === undefined || target === undefined) continue;

    entries.push({
      id: row.id,
      type: row.type,
      createdAt: row.createdAt,
      actor,
      target,
      text: renderEntry(row.type, actor, target, arena.name),
      payload: row.payload,
    });
  }

  return {
    arena: { slug: arena.slug, name: arena.name, type: arena.type },
    entries,
    nextBefore:
      rows.length >= limit * 3 && entries.length === limit
        ? (entries.at(-1)?.createdAt ?? null)
        : null,
  };
}

// ── Longest Reign ──────────────────────────────────────────────────────────

export interface ReignRecord {
  arena: { slug: string; name: string };
  holder: FeedActor;
  startedAt: Date;
  endedAt: Date | null;
  /** Whole days held, rounded down. An open reign counts to now. */
  days: number;
  peakPoints: number;
  /** True while the holder still sits on the Throne. */
  open: boolean;
  /** Who ended it, if anyone. */
  endedBy: FeedActor | null;
}

/**
 * The Longest Reign hall of fame — `#5.1`.
 *
 * "Longest Reign is its own permanent hall-of-fame board, so being dethroned
 * still leaves a record — this softens churn at the top and gives a second
 * axis to compete on."
 *
 * Permanent, so it reads across every arena and every closed season. Open
 * reigns are included and measured to now, because a reign in progress is
 * exactly what a Sovereign is trying to extend.
 */
export async function longestReigns(
  db: Db,
  options: {
    limit?: number;
    now?: Date;
    arenaSlug?: string;
    viewerId?: string;
  } = {},
): Promise<ReignRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const now = options.now ?? new Date();

  const conditions = options.arenaSlug
    ? [eq(arenas.slug, options.arenaSlug)]
    : [];
  conditions.push(sql`(${arenas.type} = 'global' or (${options.viewerId ?? null}::uuid is not null and
    (${arenas.ownerUserId} = ${options.viewerId ?? null}::uuid or exists (
      select 1 from arena_members access_member where access_member.arena_id = ${arenas.id}
      and access_member.user_id = ${options.viewerId ?? null}::uuid and access_member.status <> 'left'
    ))))`);

  /**
   * Reign length in seconds, measuring an open reign to `now`.
   *
   * `now` is interpolated as an ISO string with an explicit `::timestamptz`
   * cast, not as a `Date`. postgres.js cannot infer a type for a bare Date
   * inside a `sql` template and fails with "The string argument must be of
   * type string... Received an instance of Date".
   *
   * Defined once and reused in both SELECT and ORDER BY so the two can never
   * disagree about what is being ranked.
   */
  const duration = sql<string>`extract(epoch from (coalesce(${reigns.endedAt}, ${now.toISOString()}::timestamptz) - ${reigns.startedAt}))`;

  const rows = await db
    .select({
      reignId: reigns.id,
      arenaId: reigns.arenaId,
      arenaSlug: arenas.slug,
      arenaName: arenas.name,
      userId: reigns.userId,
      startedAt: reigns.startedAt,
      endedAt: reigns.endedAt,
      endedByUserId: reigns.endedByUserId,
      peakPoints: reigns.peakPoints,
      // Ordered in SQL so the limit is applied to the right rows.
      duration,
    })
    .from(reigns)
    .innerJoin(arenas, eq(arenas.id, reigns.arenaId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(duration))
    .limit(limit * 3);

  // Visibility is per arena, so fetch membership for the arenas in play.
  const arenaIds = [...new Set(rows.map((r) => r.arenaId))];
  const members = new Map<
    string,
    Map<string, { handle: string; visibility: string; status: string }>
  >();

  if (arenaIds.length > 0) {
    const memberRows = await db
      .select({
        arenaId: arenaMembers.arenaId,
        userId: arenaMembers.userId,
        handle: users.handle,
        visibility: arenaMembers.visibility,
        status: arenaMembers.status,
      })
      .from(arenaMembers)
      .innerJoin(users, eq(users.id, arenaMembers.userId))
      .where(inArray(arenaMembers.arenaId, arenaIds));
    for (const row of memberRows) {
      if (!members.has(row.arenaId)) members.set(row.arenaId, new Map());
      members.get(row.arenaId)!.set(row.userId, row);
    }
  }

  const out: ReignRecord[] = [];

  for (const row of rows) {
    if (out.length >= limit) break;

    const arenaMembersMap = members.get(row.arenaId) ?? new Map();
    const holder = resolveActor(row.userId, arenaMembersMap);
    // A hall of fame entry for a hidden member is still a leak.
    if (holder === undefined || holder === null) continue;

    const endedBy = resolveActor(row.endedByUserId, arenaMembersMap);

    out.push({
      arena: { slug: row.arenaSlug, name: row.arenaName },
      holder,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      days: Math.floor(Number(row.duration) / 86_400),
      peakPoints: row.peakPoints,
      open: row.endedAt === null,
      // `undefined` (hidden) collapses to null rather than dropping the whole
      // record — the reign itself is the achievement being honoured.
      endedBy: endedBy === undefined ? null : endedBy,
    });
  }

  return out;
}

/** The current Sovereign of an arena, if there is one. */
export async function currentSovereign(
  db: Db,
  arenaId: string,
): Promise<
  { userId: string; startedAt: Date; peakPoints: number } | undefined
> {
  const [open] = await db
    .select({
      userId: reigns.userId,
      startedAt: reigns.startedAt,
      peakPoints: reigns.peakPoints,
    })
    .from(reigns)
    .where(and(eq(reigns.arenaId, arenaId), isNull(reigns.endedAt)))
    .limit(1);
  return open;
}
