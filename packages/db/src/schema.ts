/**
 * Postgres schema — `SPEC.md#6`.
 *
 * The full `#6` model is defined here even though M0 only writes `users`,
 * `devices`, `device_enrollments`, `usage_events`, `arenas` and
 * `arena_members`. Defining it once means M1-M3 add behaviour, not migrations
 * that reshape hot tables.
 *
 * Two invariants from the spec are enforced structurally rather than in code:
 *
 *   - `daily_scores` is keyed on `(user_id, day)`, *not* season (`#6`). Scores
 *     are computed once globally; arenas are views over them. Putting a season
 *     in that key is what would force per-arena scoring logic.
 *   - `reigns` and `events` are append-only (`#6.2`). Nothing in this schema
 *     grants them an update path; a dethrone that was announced stands.
 */

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** `#2` — per-arena visibility. `anonymous` competes under a pseudonym. */
export const visibilityEnum = pgEnum("visibility", ["public", "anonymous", "hidden"]);

/** `#2` — the three scopes, one entity. */
export const arenaTypeEnum = pgEnum("arena_type", ["global", "org", "club"]);

/** `#3.4` — trust tiers, shown as a badge and filterable on every board. */
export const trustTierEnum = pgEnum("trust_tier", ["unverified", "cli_signed", "org_verified"]);

/** `#5.2` — eliminated members stay visible, greyed as "out". */
export const memberStatusEnum = pgEnum("member_status", ["active", "eliminated", "left"]);

export const seasonStateEnum = pgEnum("season_state", ["upcoming", "active", "closed"]);

export const duelStateEnum = pgEnum("duel_state", [
  "proposed",
  "accepted",
  "declined",
  "settled",
  "expired",
]);

/**
 * `#3.4` — an anomaly shadow-freezes a user's rank pending review rather than
 * hard-rejecting, because false positives on a heavy user are worse than a
 * slow cheat.
 */
export const reviewStateEnum = pgEnum("review_state", ["clear", "shadow_frozen"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    /** Set from the OAuth identity; `#2` uses it for org verification. */
    emailDomain: text("email_domain"),
    defaultVisibility: visibilityEnum("default_visibility").notNull().default("public"),
    reviewState: reviewStateEnum("review_state").notNull().default("clear"),
    /**
     * Whether the user has accepted or chosen their handle.
     *
     * First OAuth login derives a provisional handle from the provider profile
     * rather than blocking on an onboarding form — a leaderboard you cannot see
     * until you have filled in a field is a leaderboard people bounce off. The
     * flag drives a one-time prompt to confirm or change it, so a derived
     * handle is never mistaken for a chosen one.
     */
    handleConfirmed: boolean("handle_confirmed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Uniqueness is on `lower(handle)`, not `handle`: on a board where the
    // handle *is* the identity people recognize, "Kenn" and "kenn" must not be
    // two competitors. Callers still store the casing the user chose.
    uniqueIndex("users_handle_lower_idx").on(sql`lower(${t.handle})`),
  ],
);

export const identities = pgTable(
  "identities",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUid: text("provider_uid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerUid] }),
    index("identities_user_idx").on(t.userId),
  ],
);

/**
 * Browser sessions.
 *
 * Opaque random tokens, not JWTs. The cookie carries the token; only its
 * SHA-256 lands here, so a dump of this table yields nothing usable. The
 * tradeoff — a database read per request — buys instant revocation, which a
 * self-contained token cannot offer at all: signing someone out, or cutting off
 * a stolen cookie, has to be a delete somewhere.
 */
export const sessions = pgTable(
  "sessions",
  {
    /** `sha256(token)`, hex. The token itself is never stored. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Refreshed on use, to drive the sliding window without a write per hit. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    /** Coarse provenance for a "your sessions" list. Never a full user agent. */
    userAgent: text("user_agent"),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    // Lets the expiry sweep be an index scan rather than a table scan.
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

export const devices = pgTable(
  "devices",
  {
    /** Client-visible id, carried in every payload's `device_id`. */
    id: text("id").primaryKey(),
    usageRevision: integer("usage_revision").notNull().default(1),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * Raw 32-byte ed25519 public key, base64url.
     *
     * The public half only. The private key is generated on the device and
     * lives in its OS keychain; it is never transmitted and there is no column
     * here that could hold it.
     */
    publicKey: text("public_key").notNull(),
    label: text("label"),
    trustTier: trustTierEnum("trust_tier").notNull().default("cli_signed"),
    /**
     * Highest `seq` accepted from this device. `#3.4`'s monotonic per-device
     * counter: a batch must advance it, which is what makes a captured payload
     * useless on resubmission.
     */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set to revoke a lost or compromised device without touching the account. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    // One device per key. Re-registering the same key must not create a second
    // identity whose `last_seq` starts back at zero.
    uniqueIndex("devices_public_key_idx").on(t.publicKey),
    index("devices_user_idx").on(t.userId),
  ],
);

/**
 * One-time device enrollment codes.
 *
 * M0 has no OAuth (that is `#9` M1), so `usurp login <code>` trades a
 * short-lived code for a registered device. Only the hash is stored, so a
 * database leak does not yield usable codes.
 */
export const deviceEnrollments = pgTable(
  "device_enrollments",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** The device the code produced, for audit. */
    deviceId: text("device_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("device_enrollments_user_idx").on(t.userId)],
);

/**
 * `#3.3` — one row per (device, hour, agent, model).
 *
 * Every column is an aggregate counter. There is deliberately no column for a
 * prompt, a completion, a file path, a repo name, a branch, a cwd, a session
 * id, or a tool argument: `#10.1` promises those never leave the machine, and a
 * schema with nowhere to put them is a stronger guarantee than a code review.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),

    agent: text("agent").notNull(),
    model: text("model").notNull(),
    /** Archive imports appear in analytics but never in rating or streaks. */
    historical: boolean("historical").notNull().default(false),
    /** UTC hour boundary. */
    hour: timestamp("hour", { withTimezone: true }).notNull(),

    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),

    calls: integer("calls").notNull().default(0),
    sessionsStarted: integer("sessions_started").notNull().default(0),
    sessionsCompleted: integer("sessions_completed").notNull().default(0),
    sessionsAbandoned: integer("sessions_abandoned").notNull().default(0),

    editsApplied: integer("edits_applied").notNull().default(0),
    editsReverted: integer("edits_reverted").notNull().default(0),
    commits: integer("commits").notNull().default(0),

    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),

    /** `sha256(device_id|hour|agent|model)`. See the upsert note below. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Whether the batch carrying this row verified against the device key. */
    sigOk: boolean("sig_ok").notNull(),
    /** Non-fatal gate codes from `#3.4`, e.g. `["cost_mismatch"]`. */
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * `#3.4` — UNIQUE so replays are no-ops.
     *
     * The ingest path upserts with `GREATEST()` per counter rather than `DO
     * NOTHING`. A true replay carries identical values and changes nothing, so
     * the spec's intent holds; but a session crossing the top of an hour
     * legitimately *revises* an already-submitted bucket (its completion lands
     * in the next hour, while a re-read of the earlier hour now sees the full
     * picture). `DO NOTHING` would silently drop those corrections. Counters
     * only grow as more of an hour is observed, which is what makes
     * `GREATEST()` both correct and idempotent.
     */
    uniqueIndex("usage_events_dedupe_key_idx").on(t.dedupeKey),
    // The Burn board's read path: a user's rows over a window.
    index("usage_events_user_hour_idx").on(t.userId, t.hour),
    index("usage_events_device_idx").on(t.deviceId),
  ],
);

export const arenas = pgTable(
  "arenas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: arenaTypeEnum("type").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    inviteCode: text("invite_code"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    /** `#2` — clubs cap at 50; global and org are unbounded (null). */
    maxMembers: integer("max_members"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("arenas_slug_idx").on(t.slug),
    uniqueIndex("arenas_invite_code_idx").on(t.inviteCode),
  ],
);

export const arenaMembers = pgTable(
  "arena_members",
  {
    arenaId: uuid("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * `#2` — org arenas default to `hidden` and are opt-in per member. That
     * default is the product invariant that separates Usurp from an internal
     * surveillance board, so it is set per row at join time by the arena's
     * type rather than inherited from the user's global preference.
     */
    visibility: visibilityEnum("visibility").notNull().default("public"),
    status: memberStatusEnum("status").notNull().default("active"),
  },
  (t) => [
    primaryKey({ columns: [t.arenaId, t.userId] }),
    index("arena_members_user_idx").on(t.userId),
  ],
);

export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    arenaId: uuid("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** `#5.2` — the shrinking-circle schedule for this season. */
    circleSchedule: jsonb("circle_schedule").$type<Record<string, unknown>>().notNull().default({}),
    state: seasonStateEnum("state").notNull().default("upcoming"),
  },
  (t) => [uniqueIndex("seasons_arena_idx_idx").on(t.arenaId, t.idx)],
);

/**
 * `#6` — keyed on user and day, never season. One computation, many arena
 * views, so a user's rating is consistent everywhere and arena joins are cheap.
 */
export const dailyScores = pgTable(
  "daily_scores",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** UTC date. */
    day: timestamp("day", { withTimezone: true }).notNull(),
    volumePts: integer("volume_pts").notNull().default(0),
    /** `#4.2` multipliers, stored in basis points to keep the row integral. */
    efficiencyMultBp: integer("efficiency_mult_bp").notNull().default(10_000),
    streakMultBp: integer("streak_mult_bp").notNull().default(10_000),
    points: integer("points").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * `#6` — a real table refreshed transactionally, not a view. The board is the
 * hottest read path and must not recompute per request.
 */
export const standings = pgTable(
  "standings",
  {
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Season points including any duel adjustment — the ranking value. */
    points: integer("points").notNull().default(0),
    /**
     * `#5.3` — net rating points won or lost in duels this season.
     *
     * A separate column because `points` is *derived*: the recompute replays it
     * from `daily_scores` every ten minutes, so a wager written into `points`
     * would vanish at the next run. Settlement owns this column, the recompute
     * owns the rest, and `points` is the sum of the two.
     */
    duelPts: integer("duel_pts").notNull().default(0),
    rank: integer("rank"),
    prevRank: integer("prev_rank"),
    status: memberStatusEnum("status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.userId] }),
    index("standings_season_rank_idx").on(t.seasonId, t.rank),
  ],
);

/**
 * `#5.1` — append-only. A change of #1 closes the old reign and opens a new
 * one; `#6.2` forbids rewriting either, even when late data would have
 * prevented the dethrone.
 */
export const reigns = pgTable(
  "reigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    arenaId: uuid("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "set null" }),
    peakPoints: integer("peak_points").notNull().default(0),
  },
  (t) => [
    index("reigns_arena_idx").on(t.arenaId),
    // `#6.1` takes a per-arena advisory lock around the standings write; this
    // partial index makes "is there an open reign here?" a single-row lookup.
    index("reigns_arena_open_idx").on(t.arenaId, t.endedAt),
  ],
);

export const duels = pgTable(
  "duels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    arenaId: uuid("arena_id")
      .notNull()
      .references(() => arenas.id, { onDelete: "cascade" }),
    challengerId: uuid("challenger_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    opponentId: uuid("opponent_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    wagerPts: integer("wager_pts").notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    state: duelStateEnum("state").notNull().default("proposed"),
    winnerId: uuid("winner_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    // `#5` caps duels at 2 concurrent per user; both sides need a cheap count.
    index("duels_challenger_idx").on(t.challengerId, t.state),
    index("duels_opponent_idx").on(t.opponentId, t.state),
    // The settlement sweep looks for accepted duels whose window has closed.
    index("duels_settlement_idx").on(t.state, t.windowEnd),
    index("duels_arena_idx").on(t.arenaId),
  ],
);

/**
 * `#6` — one append-only log powering the feed, notifications, and the audit
 * trail.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    arenaId: uuid("arena_id").references(() => arenas.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    targetId: uuid("target_id").references(() => users.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("events_arena_created_idx").on(t.arenaId, t.createdAt)],
);

/** `#9` M3 — "notifications (email / webhook / Slack)". */
export const channelKindEnum = pgEnum("channel_kind", ["webhook", "slack", "email"]);

export const deliveryStatusEnum = pgEnum("delivery_status", [
  "pending",
  "sent",
  "failed",
  /** Withheld by `#5`'s rate limit, not by an error. */
  "suppressed",
]);

/**
 * Where a user wants to be told things.
 *
 * Per user rather than per arena: `#5` rate-limits by arena, but a person has
 * one inbox. Someone in five clubs does not want five webhooks to configure.
 */
export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: channelKindEnum("kind").notNull(),
    /** Webhook/Slack URL, or an email address. */
    target: text("target").notNull(),
    /**
     * HMAC key for signing webhook bodies, so a receiver can verify the call
     * came from us. Generated server-side; shown to the user once.
     */
    secret: text("secret"),
    enabled: boolean("enabled").notNull().default(true),
    /** Last delivery failure, surfaced in settings so a dead URL is visible. */
    lastError: text("last_error"),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notification_channels_user_idx").on(t.userId),
    // One channel per target per user; re-adding the same URL is an edit.
    uniqueIndex("notification_channels_target_idx").on(t.userId, t.kind, t.target),
  ],
);

/**
 * One row per (event, channel) — the delivery ledger.
 *
 * Exists for three reasons at once: idempotency (the unique index means a
 * retried dispatch cannot double-send), `#5`'s rate limit (it is the record of
 * what was sent and when), and the audit trail `#6` wants from one log.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    status: deliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The idempotency guarantee: one delivery per event per channel, ever.
    uniqueIndex("notification_deliveries_unique_idx").on(t.eventId, t.channelId),
    index("notification_deliveries_pending_idx").on(t.status, t.createdAt),
  ],
);

export const achievements = pgTable("achievements", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  tier: smallint("tier").notNull().default(1),
  predicate: jsonb("predicate").$type<Record<string, unknown>>().notNull().default({}),
});

export const userAchievements = pgTable(
  "user_achievements",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    code: text("code")
      .notNull()
      .references(() => achievements.code, { onDelete: "cascade" }),
    earnedAt: timestamp("earned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

/** Short-lived browser approval requests. Polling secrets are stored hashed. */
export const devicePairings = pgTable("device_pairings", {
  codeHash: text("code_hash").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  publicKey: text("public_key").notNull(),
  label: text("label").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  decision: text("decision"),
  deviceId: text("device_id").references(() => devices.id, { onDelete: "cascade" }),
}, (t) => [index("device_pairings_expiry_idx").on(t.expiresAt)]);

export const usersRelations = relations(users, ({ many }) => ({
  identities: many(identities),
  devices: many(devices),
  usageEvents: many(usageEvents),
  memberships: many(arenaMembers),
}));

export const devicesRelations = relations(devices, ({ one, many }) => ({
  user: one(users, { fields: [devices.userId], references: [users.id] }),
  usageEvents: many(usageEvents),
}));

/** Recoverable audit of explicit reader repairs; aggregates only, no keys. */
export const usageBridgeSnapshots = pgTable("usage_bridge_snapshots", {
  deviceId: text("device_id").primaryKey().references(() => devices.id, { onDelete: "cascade" }),
  snapshot: jsonb("snapshot").$type<import("@usurp/protocol").BridgeSnapshot>().notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageRepairBackups = pgTable("usage_repair_backups", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rows: jsonb("rows").$type<unknown[]>().notNull(),
});

export const arenasRelations = relations(arenas, ({ many }) => ({
  members: many(arenaMembers),
  seasons: many(seasons),
}));

export const arenaMembersRelations = relations(arenaMembers, ({ one }) => ({
  arena: one(arenas, { fields: [arenaMembers.arenaId], references: [arenas.id] }),
  user: one(users, { fields: [arenaMembers.userId], references: [users.id] }),
}));

export type User = typeof users.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type Arena = typeof arenas.$inferSelect;
export type ArenaMember = typeof arenaMembers.$inferSelect;
