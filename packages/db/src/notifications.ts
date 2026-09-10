/**
 * Notifications — `SPEC.md#9` M3 ("email / webhook / Slack"), `#5`.
 *
 * ── The rate limit is the feature ───────────────────────────────────────────
 * `#5`: "Rate-limit the drama: at most one `dethroned` notification per arena
 * per hour... A board that pings all day gets muted, and a muted board is a
 * dead board."
 *
 * That is not a nicety. The recompute runs every ten minutes, and rank 1 in an
 * active arena changes on many of those passes — so an unthrottled dispatcher
 * would fire six usurping alerts an hour, per arena, and would train people to
 * ignore it inside a day. The limit is enforced here, centrally, rather than
 * left to each channel to remember.
 *
 * ── Two invariants ──────────────────────────────────────────────────────────
 * 1. `#6` gives one append-only `events` log powering "the feed, notifications,
 *    and the audit trail". This *reads* that log; it never keeps its own queue
 *    of things to say. Throttling therefore suppresses the interruption, not
 *    the record — the feed still shows every usurping.
 * 2. Names are resolved through `arenaVisibility()`, the same function the feed
 *    uses. A notification must not be the one surface that names someone who
 *    competes anonymously (`#2`). A recipient always sees their *own* handle,
 *    because they already know who they are, so the payload is built per
 *    recipient rather than once per event.
 */

import { randomBytes, createHmac } from "node:crypto";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { postWebhook, publicAddress } from "./webhook-http.js";
import { isIP } from "node:net";
import {
  arenas,
  events,
  notificationChannels,
  notificationDeliveries,
  users,
} from "./schema.js";
import { arenaVisibility, resolveActor, type FeedActor } from "./feed.js";
import { EVENT_CROWNED, EVENT_USURPED } from "./titles.js";
import {
  EVENT_DUEL_ACCEPTED,
  EVENT_DUEL_PROPOSED,
  EVENT_DUEL_SETTLED,
} from "./duels.js";

export type ChannelKind = "webhook" | "slack" | "email";
export type Channel = typeof notificationChannels.$inferSelect;

/** `#5` — at most one throne alert per arena per hour. */
export const THRONE_COOLDOWN_MS = 60 * 60 * 1000;

/** How far back a dispatch run looks. Older events are water under the bridge. */
export const DISPATCH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Delivery rows older than this are pruned; the `events` log is untouched. */
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How long to wait on a receiver before treating the attempt as failed. */
export const SEND_TIMEOUT_MS = 8_000;

/**
 * Event types worth interrupting someone for.
 *
 * Deliberately short. `crowned` is included because a first Sovereign is news.
 * Eliminations are not: `#5.2` already shows them on the board, and a "you were
 * cut" push is a reason to close the tab rather than open it.
 */
export const NOTIFIABLE: readonly string[] = [
  EVENT_USURPED,
  EVENT_CROWNED,
  EVENT_DUEL_PROPOSED,
  EVENT_DUEL_ACCEPTED,
  EVENT_DUEL_SETTLED,
];

/** Types the `#5` cooldown applies to — the throne churn it was written for. */
export const THROTTLED: readonly string[] = [EVENT_USURPED, EVENT_CROWNED];

// ── Channel management ─────────────────────────────────────────────────────

export type AddChannelFailure =
  | "invalid_target"
  | "duplicate"
  | "email_not_verified"
  | "email_unavailable";

export interface AddedChannel {
  channel: Channel;
  /**
   * The signing secret, returned **once** at creation.
   *
   * Shown to the user so they can verify our signatures, and never returned by
   * a read path — the same reasoning as `sessions` storing only a token hash.
   */
  secret: string | null;
}

export type AddChannelResult =
  | { ok: true; added: AddedChannel }
  | { ok: false; failure: AddChannelFailure };

/**
 * Validate a delivery target.
 *
 * A server-side POST to a user-supplied URL is an SSRF primitive, and
 * `http://169.254.169.254/` is the textbook target, so private and loopback
 * addresses are refused. HTTPS is required outside development. This is not
 * sufficient on its own: the transport additionally validates and pins the
 * actual DNS results used by the connection to prevent rebinding.
 */
export function validateTarget(kind: ChannelKind, target: string): boolean {
  if (target.length > 2048) return false;

  if (kind === "email") {
    return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(target) && target.length <= 254;
  }

  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  // Loopback over plain HTTP is how you test a webhook on your own machine, so
  // it is allowed in development and refused in production.
  const allowInsecure = process.env.NODE_ENV !== "production";
  if (
    url.protocol !== "https:" &&
    !(allowInsecure && url.protocol === "http:")
  ) {
    return false;
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.username || url.password) return false;
  if (
    process.env.NODE_ENV === "production" &&
    isIP(host) &&
    !publicAddress(host)
  )
    return false;

  /**
   * Link-local is refused in *every* environment, not just production.
   *
   * `169.254.169.254` is the AWS/GCP instance metadata service. Unlike
   * loopback, there is no development workflow that legitimately posts a
   * webhook there — the only reason to enter it is to make our dispatcher
   * fetch credentials on someone's behalf. `.internal` is the same idea by
   * name rather than by number.
   */
  if (
    /^169\.254\./.test(host) ||
    /^fe[89ab][0-9a-f]:/.test(host) ||
    host.endsWith(".internal")
  ) {
    return false;
  }

  // Loopback and RFC 1918, on the other hand, are how you test a receiver on
  // your own machine, so they are allowed in development only.
  const isPrivate =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^(127\.|0\.|10\.|192\.168\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host);

  if (isPrivate) return allowInsecure;

  // Slack's incoming webhooks only ever live here; anything else claiming to be
  // Slack is a mistake or a redirect.
  if (kind === "slack") return host === "hooks.slack.com";
  return true;
}

export async function addChannel(
  db: Db,
  userId: string,
  kind: ChannelKind,
  target: string,
): Promise<AddChannelResult> {
  const trimmed = target.trim();
  if (!validateTarget(kind, trimmed)) {
    return { ok: false, failure: "invalid_target" };
  }
  if (kind === "email") {
    if (!emailNotificationsEnabled())
      return { ok: false, failure: "email_unavailable" };
    const verified = await db.execute(
      sql`select 1 from identities where user_id = ${userId} and provider = 'email' and provider_uid = ${trimmed.toLowerCase()} limit 1`,
    );
    if (!verified.length) return { ok: false, failure: "email_not_verified" };
  }

  // Only webhooks get a signing secret; there is nothing to verify an email
  // with, and Slack authenticates by the secrecy of the hook URL itself.
  const secret =
    kind === "webhook" ? randomBytes(24).toString("base64url") : null;

  try {
    const [channel] = await db
      .insert(notificationChannels)
      .values({ userId, kind, target: trimmed, secret })
      .returning();
    return { ok: true, added: { channel: channel!, secret } };
  } catch {
    // The unique index on `(user_id, kind, target)` is the only realistic
    // failure here, and re-adding the same hook is a no-op worth reporting
    // rather than an error worth logging.
    return { ok: false, failure: "duplicate" };
  }
}

export async function removeChannel(
  db: Db,
  userId: string,
  channelId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, channelId),
        eq(notificationChannels.userId, userId),
      ),
    )
    .returning({ id: notificationChannels.id });
  return deleted.length > 0;
}

export async function setChannelEnabled(
  db: Db,
  userId: string,
  channelId: string,
  enabled: boolean,
): Promise<boolean> {
  const updated = await db
    .update(notificationChannels)
    .set({ enabled })
    .where(
      and(
        eq(notificationChannels.id, channelId),
        eq(notificationChannels.userId, userId),
      ),
    )
    .returning({ id: notificationChannels.id });
  return updated.length > 0;
}

/**
 * Reveal a webhook's signing secret to its owner.
 *
 * Deliberately a separate call from `channelsFor`, so the list that renders on
 * every settings load does not carry secrets it does not need. Unlike a device
 * private key (`#3.3`), this is *our* HMAC key, not the user's identity — the
 * owner has to be able to read it to verify our signatures, and re-reading it
 * grants no capability they did not already have.
 */
export async function revealChannelSecret(
  db: Db,
  userId: string,
  channelId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ secret: notificationChannels.secret })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.id, channelId),
        eq(notificationChannels.userId, userId),
      ),
    )
    .limit(1);
  return row?.secret ?? null;
}

/** A channel as shown in settings. The secret is deliberately absent. */
export interface ChannelView {
  id: string;
  kind: ChannelKind;
  target: string;
  enabled: boolean;
  signed: boolean;
  lastError: string | null;
  lastDeliveredAt: Date | null;
  createdAt: Date;
}

export async function channelsFor(
  db: Db,
  userId: string,
): Promise<ChannelView[]> {
  const rows = await db
    .select()
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, userId))
    .orderBy(desc(notificationChannels.createdAt));

  return rows.map((c) => ({
    id: c.id,
    kind: c.kind,
    target: c.target,
    enabled: c.enabled,
    signed: c.secret !== null,
    lastError: c.lastError,
    lastDeliveredAt: c.lastDeliveredAt,
    createdAt: c.createdAt,
  }));
}

// ── Payloads and transport ─────────────────────────────────────────────────

export interface NotificationPayload {
  event: string;
  /** Arena slug, or null for an arena-less event. */
  arena: string | null;
  arenaName: string | null;
  /** Rendered sentence, already visibility-safe for this recipient. */
  text: string;
  actor: string | null;
  target: string | null;
  occurredAt: string;
  url: string | null;
}

/**
 * Sign a webhook body.
 *
 * The timestamp is inside the signed material so a captured body cannot be
 * replayed indefinitely — a receiver rejects a stale `x-usurp-timestamp` and
 * the signature over a fresh one will not match. The same reasoning as
 * `#3.3`'s per-device `seq`, applied outbound.
 */
export function signBody(
  secret: string,
  body: string,
  timestamp: number,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export interface Transport {
  send(channel: Channel, payload: NotificationPayload): Promise<SendResult>;
}

/**
 * The default transport.
 *
 * Webhooks pin validated DNS results to the connection. Email uses the
 * deployment's Resend credentials and accepts only linked, verified addresses.
 */
export const httpTransport: Transport = {
  async send(channel, payload) {
    if (channel.kind === "email") {
      if (!emailNotificationsEnabled())
        return {
          ok: false,
          error: "email delivery is not configured on this deployment",
        };
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: {
            authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: process.env.AUTH_EMAIL_FROM,
            to: [channel.target],
            subject: "Your Usurp arena update",
            text: `${payload.text}\n\n${payload.url ?? ""}\n\nManage or disable these notifications in Usurp Settings.`,
          }),
        });
        return response.ok
          ? { ok: true }
          : {
              ok: false,
              error: `email provider returned HTTP ${response.status}`,
            };
      } catch {
        return { ok: false, error: "email delivery failed" };
      }
    }

    const body =
      channel.kind === "slack"
        ? JSON.stringify({ text: payload.text })
        : JSON.stringify(payload);

    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "usurp-notifier/1",
    };

    if (channel.secret) {
      headers["x-usurp-timestamp"] = String(timestamp);
      headers["x-usurp-signature"] =
        `sha256=${signBody(channel.secret, body, timestamp)}`;
    }

    try {
      if (!validateTarget(channel.kind, channel.target))
        return { ok: false, error: "invalid delivery target" };
      const status = await postWebhook(
        channel.target,
        headers,
        body,
        SEND_TIMEOUT_MS,
      );
      if (status >= 200 && status < 300) return { ok: true };
      return { ok: false, error: `receiver returned HTTP ${status}` };
    } catch {
      return { ok: false, error: "webhook delivery failed" };
    }
  },
};

export function emailNotificationsEnabled() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() && process.env.AUTH_EMAIL_FROM?.trim(),
  );
}

// ── Dispatch ───────────────────────────────────────────────────────────────

export interface DispatchSummary {
  considered: number;
  sent: number;
  suppressed: number;
  failed: number;
}

export interface DispatchOptions {
  now?: Date;
  transport?: Transport;
  /** Cap on events examined per run, so a backlog cannot stall the worker. */
  limit?: number;
}

type EventRow = typeof events.$inferSelect;

/**
 * Deliver notifications for recent events.
 *
 * Recipients are the event's **actor and target only**, not every arena member.
 * `#5.1` promises "a notification to both parties"; broadcasting a usurping to
 * fifty club members is the definition of the board that pings all day.
 */
export async function dispatchNotifications(
  db: Db,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const now = options.now ?? new Date();
  const transport = options.transport ?? httpTransport;
  const limit = options.limit ?? 200;
  const since = new Date(now.getTime() - DISPATCH_LOOKBACK_MS);

  const recent = await db
    .select()
    .from(events)
    .where(
      and(
        gte(events.createdAt, since),
        lt(events.createdAt, now),
        inArray(events.type, [...NOTIFIABLE]),
      ),
    )
    // Oldest first, so the cooldown lets the *first* usurping of the hour
    // through rather than whichever one the sort happened to surface.
    .orderBy(events.createdAt)
    .limit(limit);

  const summary: DispatchSummary = {
    considered: recent.length,
    sent: 0,
    suppressed: 0,
    failed: 0,
  };
  if (recent.length === 0) return summary;

  const arenaCache = new Map<string, { slug: string; name: string } | null>();
  const visibilityCache = new Map<
    string,
    Map<string, { handle: string; visibility: string; status: string }>
  >();
  const handles = await handleMap(db, recent);

  for (const event of recent) {
    const channels = await recipientChannels(db, event);
    if (channels.length === 0) continue;

    // `#5`'s cooldown, measured against *deliveries* rather than events so the
    // log stays complete and only the interruption is throttled.
    if (event.arenaId && THROTTLED.includes(event.type)) {
      if (await throttled(db, event.arenaId, now)) {
        // Recorded as `suppressed`, not skipped: the ledger then explains the
        // silence, and the unique index stops a later run resurrecting it.
        for (const channel of channels) {
          await claimDelivery(db, event.id, channel.id, now, "suppressed");
        }
        summary.suppressed++;
        continue;
      }
    }

    let arena: { slug: string; name: string } | null = null;
    let members = new Map<
      string,
      { handle: string; visibility: string; status: string }
    >();

    if (event.arenaId) {
      if (!arenaCache.has(event.arenaId)) {
        const [row] = await db
          .select({ slug: arenas.slug, name: arenas.name })
          .from(arenas)
          .where(eq(arenas.id, event.arenaId))
          .limit(1);
        arenaCache.set(event.arenaId, row ?? null);
        visibilityCache.set(
          event.arenaId,
          await arenaVisibility(db, event.arenaId),
        );
      }
      arena = arenaCache.get(event.arenaId) ?? null;
      members = visibilityCache.get(event.arenaId) ?? members;
    }

    for (const channel of channels) {
      const deliveryId = await claimDelivery(
        db,
        event.id,
        channel.id,
        now,
        "pending",
      );
      // Null means a row already exists — this event has been attempted for
      // this channel. That single index is what makes dispatch idempotent.
      if (!deliveryId) continue;

      const payload = buildPayload(
        event,
        channel.userId,
        members,
        handles,
        arena,
      );
      const result = await transport.send(channel, payload);
      await recordResult(db, deliveryId, channel.id, result, now);
      if (result.ok) summary.sent++;
      else summary.failed++;
    }
  }

  return summary;
}

async function handleMap(
  db: Db,
  rows: EventRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .flatMap((e) => [e.actorId, e.targetId])
        .filter((v): v is string => !!v),
    ),
  ];
  if (ids.length === 0) return new Map();

  const found = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.handle]));
}

/** Enabled channels belonging to the event's actor or target. */
async function recipientChannels(db: Db, event: EventRow): Promise<Channel[]> {
  const ids = [event.actorId, event.targetId].filter((v): v is string => !!v);
  if (ids.length === 0) return [];

  return db
    .select()
    .from(notificationChannels)
    .where(
      and(
        inArray(notificationChannels.userId, ids),
        eq(notificationChannels.enabled, true),
      ),
    );
}

/** True when a throne alert already went out for this arena within the hour. */
async function throttled(db: Db, arenaId: string, now: Date): Promise<boolean> {
  const [prior] = await db
    .select({ id: notificationDeliveries.id })
    .from(notificationDeliveries)
    .innerJoin(events, eq(events.id, notificationDeliveries.eventId))
    .where(
      and(
        eq(events.arenaId, arenaId),
        inArray(events.type, [...THROTTLED]),
        eq(notificationDeliveries.status, "sent"),
        gte(
          notificationDeliveries.lastAttemptAt,
          new Date(now.getTime() - THRONE_COOLDOWN_MS),
        ),
      ),
    )
    .limit(1);
  return prior !== undefined;
}

/** Insert a delivery row, returning its id, or null if one already exists. */
async function claimDelivery(
  db: Db,
  eventId: string,
  channelId: string,
  now: Date,
  status: "pending" | "suppressed",
): Promise<string | null> {
  const [row] = await db
    .insert(notificationDeliveries)
    .values({
      eventId,
      channelId,
      status,
      attempts: status === "pending" ? 1 : 0,
      lastAttemptAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: notificationDeliveries.id });
  return row?.id ?? null;
}

async function recordResult(
  db: Db,
  deliveryId: string,
  channelId: string,
  result: SendResult,
  now: Date,
): Promise<void> {
  if (result.ok) {
    await db
      .update(notificationDeliveries)
      .set({ status: "sent", lastAttemptAt: now, error: null })
      .where(eq(notificationDeliveries.id, deliveryId));
    await db
      .update(notificationChannels)
      .set({ lastDeliveredAt: now, lastError: null })
      .where(eq(notificationChannels.id, channelId));
    return;
  }

  const error = (result.error ?? "send failed").slice(0, 500);
  await db
    .update(notificationDeliveries)
    .set({ status: "failed", lastAttemptAt: now, error })
    .where(eq(notificationDeliveries.id, deliveryId));
  // Surfaced in settings, so a webhook that has been 404ing for a week is
  // visible to its owner instead of silently dropping every alert.
  await db
    .update(notificationChannels)
    .set({ lastError: error })
    .where(eq(notificationChannels.id, channelId));
}

/**
 * Render one event for one recipient.
 *
 * `viewerId` is why this is per recipient: the viewer sees their own handle
 * regardless of their arena visibility (they know who they are), while the
 * counterparty is resolved through `resolveActor` exactly as the feed does.
 */
export function buildPayload(
  event: EventRow,
  viewerId: string,
  members: Map<string, { handle: string; visibility: string; status: string }>,
  handles: Map<string, string>,
  arena: { slug: string; name: string } | null,
): NotificationPayload {
  const name = (userId: string | null): string | null => {
    if (!userId) return null;
    if (userId === viewerId) return handles.get(userId) ?? "you";
    // `undefined` from `resolveActor` means hidden or departed. Unlike the
    // feed, the notification is not dropped — the recipient is a party to the
    // event and has a right to know it happened — but the other name is
    // withheld, which is the guarantee `#2` actually makes.
    const resolved: FeedActor | null | undefined = resolveActor(
      userId,
      members,
    );
    if (resolved === undefined) return null;
    return resolved?.display ?? null;
  };

  const actor = name(event.actorId);
  const target = name(event.targetId);
  const or = (who: string | null, fallback: string) => who ?? fallback;

  const text = (() => {
    switch (event.type) {
      case EVENT_USURPED:
        return (
          `${or(actor, "Someone")} usurped the Throne from ` +
          `${or(target, "the previous Sovereign")}${arena ? ` in ${arena.name}` : ""}.`
        );
      case EVENT_CROWNED:
        return `${or(actor, "Someone")} took the Throne${arena ? ` of ${arena.name}` : ""}.`;
      case EVENT_DUEL_PROPOSED:
        return `${or(actor, "Someone")} challenged ${or(target, "you")} to a duel.`;
      case EVENT_DUEL_ACCEPTED:
        return `${or(actor, "Someone")} accepted a duel with ${or(target, "you")}.`;
      case EVENT_DUEL_SETTLED:
        return (event.payload as { draw?: boolean }).draw
          ? "A duel ended in a draw; both stakes were returned."
          : `${or(actor, "Someone")} won a duel against ${or(target, "their opponent")}.`;
      default:
        return `${or(actor, "Someone")} — ${event.type.replace(/_/g, " ")}.`;
    }
  })();

  const base = (process.env.USURP_BASE_URL ?? "").replace(/\/+$/, "");

  return {
    event: event.type,
    arena: arena?.slug ?? null,
    arenaName: arena?.name ?? null,
    text,
    actor,
    target,
    occurredAt: event.createdAt.toISOString(),
    url: base && arena ? `${base}/a/${arena.slug}` : base || null,
  };
}

/**
 * Drop delivery rows past their retention window.
 *
 * The `events` log is append-only forever (`#6.2`); this ledger is not part of
 * that promise, and once an event is older than `DISPATCH_LOOKBACK_MS` its
 * rows can no longer suppress or de-duplicate anything.
 */
export async function pruneDeliveries(
  db: Db,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DELIVERY_RETENTION_MS);
  const deleted = await db
    .delete(notificationDeliveries)
    .where(lt(notificationDeliveries.createdAt, cutoff))
    .returning({ id: notificationDeliveries.id });
  return deleted.length;
}
