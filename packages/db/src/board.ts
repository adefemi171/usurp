/**
 * The Burn board — `SPEC.md#4.1`.
 *
 * Raw tokens and cost. The spec is emphatic that this is *volume, not skill*:
 * no season, no elimination, no title. M0 ships only this board, deliberately,
 * because it is the thing that draws people in while `#4`'s rating engine —
 * the actual product — is still unproven.
 *
 * `#6` requires the rating board read from the `standings` table rather than
 * recomputing per request. Burn is different: it is an aggregate over
 * `usage_events` with no ranking semantics to maintain, and the index on
 * `(user_id, hour)` makes the windowed sum cheap. When Burn gets slow it should
 * get a materialized view, not a hand-rolled cache.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { arenaMembers, arenas, usageEvents, users } from "./schema.js";

export type BoardWindow = "day" | "week" | "month" | "all";

export interface BurnRow {
  rank: number;
  /** Null when the member competes anonymously. */
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** Stable pseudonym for an `anonymous` member — `#2`. */
  pseudonym: string | null;
  effectiveTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  calls: number;
  costMicros: number;
  trustTier: "unverified" | "cli_signed" | "org_verified";
  flagged: boolean;
  /** Record warnings are not an account review or a failed signature. */
  usageWarnings: boolean;
  pricingWarnings: boolean;
  underReview: boolean;
}

export function windowStart(
  window: BoardWindow,
  now = new Date(),
): Date | undefined {
  const day = 86_400_000;
  switch (window) {
    case "day":
      return new Date(now.getTime() - day);
    case "week":
      return new Date(now.getTime() - 7 * day);
    case "month":
      return new Date(now.getTime() - 30 * day);
    case "all":
      return undefined;
  }
}

/**
 * `#2` — an `anonymous` member shows a stable pseudonym at their true rank.
 *
 * Derived from the user id so it never changes, and never from the handle,
 * which would make it reversible for anyone who can see the member list.
 */
const ADJECTIVES = [
  "Silent",
  "Restless",
  "Gilded",
  "Iron",
  "Hollow",
  "Crimson",
  "Vagrant",
  "Patient",
  "Errant",
  "Obsidian",
  "Feral",
  "Wintering",
  "Lucid",
  "Ardent",
];
const NOUNS = [
  "Falcon",
  "Warden",
  "Cipher",
  "Lantern",
  "Magpie",
  "Sentinel",
  "Harrier",
  "Ledger",
  "Anvil",
  "Quarry",
  "Beacon",
  "Corsair",
  "Thistle",
  "Kestrel",
];

export function pseudonymFor(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash = Math.imul(hash ^ userId.charCodeAt(i), 16777619) >>> 0;
  }
  const adjective = ADJECTIVES[hash % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(hash / ADJECTIVES.length) % NOUNS.length]!;
  return `Anonymous ${adjective} ${noun}`;
}

export interface BurnBoardOptions {
  trust?: BurnRow["trustTier"];
  window?: BoardWindow;
  /** Reveals the invite code when the viewer owns the arena. */
  viewerId?: string;
  limit?: number;
  offset?: number;
  now?: Date;
  /** Include members flagged by `#3.4`. Default true, matching "shown, flagged". */
  includeFlagged?: boolean;
}

export interface BurnBoard {
  arena: { slug: string; name: string; type: "global" | "org" | "club" };
  window: BoardWindow;
  rows: BurnRow[];
  /** Visible rows, after `#2` visibility filtering. */
  total: number;
  /**
   * Active members regardless of visibility — see `RatingBoard.memberCount`
   * for why the two counts must stay separate.
   */
  memberCount: number;
  /** Populated only when the viewer owns the arena. */
  inviteCode: string | null;
}

/**
 * `effective_tokens` per `#4.2`: input + output + cache_write, with cache_read
 * excluded because it is cheap. Burn ranks on this rather than on raw total
 * tokens so the two boards at least agree on what a token is worth counting.
 */
const effectiveTokens = sql<number>`
  coalesce(sum(${usageEvents.inputTokens}), 0)
  + coalesce(sum(${usageEvents.outputTokens}), 0)
  + coalesce(sum(${usageEvents.cacheWriteTokens}), 0)
`;

export async function burnBoard(
  db: Db,
  slug: string,
  options: BurnBoardOptions = {},
): Promise<BurnBoard | undefined> {
  const window = options.window ?? "week";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const since = windowStart(window, options.now);

  const [arena] = await db
    .select()
    .from(arenas)
    .where(eq(arenas.slug, slug))
    .limit(1);
  if (!arena) return undefined;

  /**
   * `#2` — hidden members are excluded from the board entirely, not merely
   * unnamed. For an org arena that default is the product invariant: an admin
   * sees aggregates only unless a member opts in.
   */
  const visible = await db
    .select({
      userId: arenaMembers.userId,
      visibility: arenaMembers.visibility,
      handle: users.handle,
      avatarUrl: users.avatarUrl,
      reviewState: users.reviewState,
    })
    .from(arenaMembers)
    .innerJoin(users, eq(users.id, arenaMembers.userId))
    .where(
      and(
        eq(arenaMembers.arenaId, arena.id),
        sql`${arenaMembers.visibility} <> 'hidden'`,
        sql`${arenaMembers.status} <> 'left'`,
      ),
    );

  const [memberTally] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(arenaMembers)
    .where(
      and(
        eq(arenaMembers.arenaId, arena.id),
        sql`${arenaMembers.status} <> 'left'`,
      ),
    );

  const memberCount = Number(memberTally?.n ?? 0);
  const inviteCode =
    options.viewerId && arena.ownerUserId === options.viewerId
      ? arena.inviteCode
      : null;

  if (visible.length === 0) {
    return {
      arena: pick(arena),
      window,
      rows: [],
      total: 0,
      memberCount,
      inviteCode,
    };
  }

  const memberIds = visible.map((m) => m.userId);
  const conditions = [inArray(usageEvents.userId, memberIds)];
  if (since) conditions.push(gte(usageEvents.hour, since));

  const totals = await db
    .select({
      userId: usageEvents.userId,
      effective: effectiveTokens,
      input: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheWrite: sql<number>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      cacheRead: sql<number>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      calls: sql<number>`coalesce(sum(${usageEvents.calls}), 0)`,
      cost: sql<number>`coalesce(sum(${usageEvents.costMicros}), 0)`,
      // A user is flagged if any of their rows in the window carries a gate
      // flag. `#3.4` shows them, flagged, rather than hiding the evidence.
      flagged: sql<boolean>`bool_or(jsonb_array_length(${usageEvents.flags}) > 0)`,
      pricingWarnings: sql<boolean>`bool_or(${usageEvents.flags} ?| array['unknown_model', 'cost_mismatch'])`,
      signed: sql<boolean>`bool_or(${usageEvents.sigOk})`,
    })
    .from(usageEvents)
    .where(and(...conditions))
    .groupBy(usageEvents.userId)
    .orderBy(desc(effectiveTokens));

  const byUser = new Map(totals.map((t) => [t.userId, t]));

  const ranked = visible
    .map((member) => {
      const t = byUser.get(member.userId);
      const anonymous = member.visibility === "anonymous";
      return {
        userId: member.userId,
        handle: anonymous ? null : member.handle,
        // Retained as null for API compatibility. Provider names are private.
        displayName: null,
        avatarUrl: anonymous ? null : member.avatarUrl,
        pseudonym: anonymous ? pseudonymFor(member.userId) : null,
        effectiveTokens: Number(t?.effective ?? 0),
        inputTokens: Number(t?.input ?? 0),
        outputTokens: Number(t?.output ?? 0),
        cacheWriteTokens: Number(t?.cacheWrite ?? 0),
        cacheReadTokens: Number(t?.cacheRead ?? 0),
        calls: Number(t?.calls ?? 0),
        costMicros: Number(t?.cost ?? 0),
        // M0 registers every device as `cli_signed`; the column is the source
        // of truth once manual upload and org verification land.
        trustTier: (t && !t.signed
          ? "unverified"
          : "cli_signed") as BurnRow["trustTier"],
        flagged: Boolean(t?.flagged) || member.reviewState === "shadow_frozen",
        usageWarnings: Boolean(t?.flagged),
        pricingWarnings: Boolean(t?.pricingWarnings),
        underReview: member.reviewState === "shadow_frozen",
      };
    })
    .filter((row) => (options.includeFlagged === false ? !row.flagged : true))
    .filter((row) => !options.trust || row.trustTier === options.trust)
    // Ties break on handle so a page boundary is stable across requests.
    .sort(
      (a, b) =>
        b.effectiveTokens - a.effectiveTokens ||
        (a.handle ?? a.pseudonym ?? "").localeCompare(
          b.handle ?? b.pseudonym ?? "",
        ),
    );

  const rows: BurnRow[] = ranked
    .map(({ userId: _userId, ...rest }, i) => ({ rank: i + 1, ...rest }))
    .slice(offset, offset + limit);

  return {
    arena: pick(arena),
    window,
    rows,
    total: ranked.length,
    memberCount,
    inviteCode,
  };
}

function pick(arena: {
  slug: string;
  name: string;
  type: "global" | "org" | "club";
}) {
  return { slug: arena.slug, name: arena.name, type: arena.type };
}
