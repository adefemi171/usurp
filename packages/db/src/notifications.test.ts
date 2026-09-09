/**
 * Notifications — `SPEC.md#9` M3, `#5`.
 *
 * The three properties worth testing are the ones a mistake in would be
 * invisible until it embarrassed someone:
 *
 *   1. the `#5` cooldown really holds (one throne alert per arena per hour),
 *   2. dispatch is idempotent (a re-run sends nothing twice), and
 *   3. an anonymous member is not named to their counterparty.
 *
 * A fake transport is used throughout, so nothing leaves the machine.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "./client.js";
import {
  arenaMembers,
  arenas,
  events,
  notificationChannels,
  notificationDeliveries,
  users,
} from "./schema.js";
import {
  addChannel,
  channelsFor,
  dispatchNotifications,
  pruneDeliveries,
  removeChannel,
  setChannelEnabled,
  signBody,
  validateTarget,
  type NotificationPayload,
  type Transport,
} from "./notifications.js";
import { EVENT_CROWNED, EVENT_USURPED } from "./titles.js";
import { signInWithOAuth } from "./auth.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-09-20T12:00:00.000Z");

/** Records what would have been sent. Never touches the network. */
function fakeTransport(fail = false): Transport & { sent: NotificationPayload[] } {
  const sent: NotificationPayload[] = [];
  return {
    sent,
    async send(_channel, payload) {
      sent.push(payload);
      return fail ? { ok: false, error: "receiver returned HTTP 500" } : { ok: true };
    },
  };
}

describe("validateTarget", () => {
  it("accepts an https webhook", () => {
    expect(validateTarget("webhook", "https://example.com/hooks/usurp")).toBe(true);
  });

  it("rejects a non-URL and a non-http scheme", () => {
    expect(validateTarget("webhook", "not a url")).toBe(false);
    expect(validateTarget("webhook", "file:///etc/passwd")).toBe(false);
    expect(validateTarget("webhook", "ftp://example.com/")).toBe(false);
  });

  it("rejects the cloud metadata endpoint in every environment", () => {
    // The reason this check exists at all. 169.254.169.254 is the AWS/GCP
    // instance metadata service; a webhook pointed at it turns our own
    // dispatcher into a credential exfiltration tool. No development workflow
    // needs it, so unlike loopback it is refused unconditionally.
    for (const env of ["production", "development", "test"]) {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = env;
      try {
        expect(validateTarget("webhook", "http://169.254.169.254/latest/meta-data/")).toBe(false);
        expect(validateTarget("webhook", "https://169.254.169.254/")).toBe(false);
        expect(validateTarget("webhook", "https://metadata.google.internal/")).toBe(false);
      } finally {
        process.env.NODE_ENV = prev;
      }
    }
  });

  it("rejects private ranges and plain http in production", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(validateTarget("webhook", "https://10.0.0.5/internal")).toBe(false);
      expect(validateTarget("webhook", "https://192.168.1.1/")).toBe(false);
      expect(validateTarget("webhook", "https://172.16.0.1/")).toBe(false);
      expect(validateTarget("webhook", "https://[::1]/")).toBe(false);
      // Plain http is refused in production even for a public host.
      expect(validateTarget("webhook", "http://example.com/hook")).toBe(false);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("allows localhost in development, so a webhook can be tested locally", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(validateTarget("webhook", "http://localhost:9099/hook")).toBe(true);
      expect(validateTarget("webhook", "http://127.0.0.1:9099/hook")).toBe(true);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("pins Slack to hooks.slack.com", () => {
    expect(validateTarget("slack", "https://hooks.slack.com/services/T/B/x")).toBe(true);
    expect(validateTarget("slack", "https://evil.example.com/services/T/B/x")).toBe(false);
  });

  it("validates email addresses", () => {
    expect(validateTarget("email", "someone@example.com")).toBe(true);
    expect(validateTarget("email", "someone@localhost")).toBe(false);
    expect(validateTarget("email", "not-an-email")).toBe(false);
  });
});

describe("signBody", () => {
  it("is deterministic and covers the timestamp", () => {
    const a = signBody("s3cret", '{"a":1}', 1_700_000_000);
    expect(a).toBe(signBody("s3cret", '{"a":1}', 1_700_000_000));
    // A different timestamp must produce a different signature, or a captured
    // body could be replayed forever.
    expect(a).not.toBe(signBody("s3cret", '{"a":1}', 1_700_000_001));
    expect(a).not.toBe(signBody("other", '{"a":1}', 1_700_000_000));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!hasDb)("notifications (database)", () => {
  const db = hasDb ? getDb() : (undefined as never);
  const createdUsers: string[] = [];
  const createdArenas: string[] = [];

  afterEach(async () => {
    for (const id of createdArenas.splice(0)) {
      await db.delete(arenas).where(eq(arenas.id, id));
    }
    for (const id of createdUsers.splice(0)) {
      await db.delete(users).where(eq(users.id, id));
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  async function newUser() {
    const { user } = await signInWithOAuth(db, {
      provider: "dev",
      providerUid: `nt_${Math.random().toString(36).slice(2, 12)}`,
      username: `nt${Math.random().toString(36).slice(2, 10)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  async function newArena(members: Array<{ id: string }>, visibility = "public") {
    const [row] = await db
      .insert(arenas)
      .values({
        type: "club",
        name: "Notify Test",
        slug: `nt-${Math.random().toString(36).slice(2, 10)}`,
        maxMembers: 50,
      })
      .returning();
    createdArenas.push(row!.id);

    for (const m of members) {
      await db.insert(arenaMembers).values({
        arenaId: row!.id,
        userId: m.id,
        visibility: visibility as "public",
      });
    }
    return row!;
  }

  async function emitUsurped(
    arenaId: string,
    actorId: string,
    targetId: string,
    at: Date,
  ): Promise<string> {
    const [row] = await db
      .insert(events)
      .values({
        arenaId,
        type: EVENT_USURPED,
        actorId,
        targetId,
        payload: {},
        createdAt: at,
      })
      .returning({ id: events.id });
    return row!.id;
  }

  async function hook(userId: string, path = "hook") {
    const result = await addChannel(db, userId, "webhook", `https://example.com/${path}`);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    return result.added;
  }

  describe("channels", () => {
    it("mints a signing secret once and never returns it again", async () => {
      const user = await newUser();
      const { added } = { added: await hook(user.id) };

      expect(added.secret).toMatch(/^[\w-]{20,}$/);
      expect(added.channel.secret).toBe(added.secret);

      // The read path used by settings must not carry the secret, for the same
      // reason `sessions` stores only a token hash.
      const views = await channelsFor(db, user.id);
      expect(views).toHaveLength(1);
      expect(views[0]!.signed).toBe(true);
      expect(JSON.stringify(views[0])).not.toContain(added.secret!);
    });

    it("refuses a duplicate target rather than creating a second channel", async () => {
      const user = await newUser();
      await hook(user.id, "same");
      const second = await addChannel(db, user.id, "webhook", "https://example.com/same");
      expect(second).toEqual({ ok: false, failure: "duplicate" });
      expect(await channelsFor(db, user.id)).toHaveLength(1);
    });

    it("rejects an SSRF target before it reaches the database", async () => {
      const user = await newUser();
      const result = await addChannel(db, user.id, "webhook", "https://169.254.169.254/");
      expect(result).toEqual({ ok: false, failure: "invalid_target" });
      expect(await channelsFor(db, user.id)).toHaveLength(0);
    });

    it("scopes removal and enabling to the owner", async () => {
      const owner = await newUser();
      const stranger = await newUser();
      const { channel } = await hook(owner.id);

      expect(await removeChannel(db, stranger.id, channel.id)).toBe(false);
      expect(await setChannelEnabled(db, stranger.id, channel.id, false)).toBe(false);
      expect(await channelsFor(db, owner.id)).toHaveLength(1);

      expect(await setChannelEnabled(db, owner.id, channel.id, false)).toBe(true);
      expect((await channelsFor(db, owner.id))[0]!.enabled).toBe(false);
      expect(await removeChannel(db, owner.id, channel.id)).toBe(true);
      expect(await channelsFor(db, owner.id)).toHaveLength(0);
    });
  });

  describe("dispatch", () => {
    it("notifies both parties to a usurping", async () => {
      const [winner, loser] = [await newUser(), await newUser()];
      const a = await newArena([winner, loser]);
      await hook(winner.id, "w");
      await hook(loser.id, "l");
      await emitUsurped(a.id, winner.id, loser.id, new Date(NOW.getTime() - 60_000));

      const transport = fakeTransport();
      const summary = await dispatchNotifications(db, { now: NOW, transport });

      expect(summary.sent).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.suppressed).toBe(0);
      expect(transport.sent.map((p) => p.event)).toEqual([EVENT_USURPED, EVENT_USURPED]);
      // Each side sees their own handle, not a pseudonym.
      const texts = transport.sent.map((p) => p.text);
      expect(texts.some((t) => t.includes(winner.handle))).toBe(true);
      expect(texts.every((t) => t.includes(loser.handle))).toBe(true);
    });

    it("is idempotent — a second run sends nothing", async () => {
      const [winner, loser] = [await newUser(), await newUser()];
      const a = await newArena([winner, loser]);
      await hook(winner.id);
      await emitUsurped(a.id, winner.id, loser.id, new Date(NOW.getTime() - 60_000));

      const first = fakeTransport();
      expect((await dispatchNotifications(db, { now: NOW, transport: first })).sent).toBe(1);

      // The worker runs every ten minutes over an overlapping window, so this
      // is the normal case, not an edge case.
      const second = fakeTransport();
      const again = await dispatchNotifications(db, { now: NOW, transport: second });
      expect(again.sent).toBe(0);
      expect(second.sent).toHaveLength(0);
    });

    it("sends at most one throne alert per arena per hour (`#5`)", async () => {
      const [a1, a2, a3] = [await newUser(), await newUser(), await newUser()];
      const a = await newArena([a1, a2, a3]);
      await hook(a1.id, "one");
      await hook(a2.id, "two");
      await hook(a3.id, "three");

      // Three throne changes in twenty minutes — exactly what a 10-minute
      // recompute produces in an active arena.
      await emitUsurped(a.id, a1.id, a2.id, new Date(NOW.getTime() - 20 * 60_000));
      await emitUsurped(a.id, a2.id, a1.id, new Date(NOW.getTime() - 10 * 60_000));
      await emitUsurped(a.id, a3.id, a2.id, new Date(NOW.getTime() - 5 * 60_000));

      const transport = fakeTransport();
      const summary = await dispatchNotifications(db, { now: NOW, transport });

      expect(summary.considered).toBe(3);
      // The first event's two parties are told; the later two are suppressed.
      expect(summary.sent).toBe(2);
      expect(summary.suppressed).toBe(2);
      expect(transport.sent).toHaveLength(2);
    });

    it("does not let one arena's cooldown mute another's", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const first = await newArena([x, y]);
      const second = await newArena([x, y]);
      await hook(x.id);

      await emitUsurped(first.id, x.id, y.id, new Date(NOW.getTime() - 10 * 60_000));
      await emitUsurped(second.id, x.id, y.id, new Date(NOW.getTime() - 5 * 60_000));

      const transport = fakeTransport();
      const summary = await dispatchNotifications(db, { now: NOW, transport });

      expect(summary.sent).toBe(2);
      expect(summary.suppressed).toBe(0);
      expect(new Set(transport.sent.map((p) => p.arena)).size).toBe(2);
    });

    it("suppression is recorded, not merely skipped", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const a = await newArena([x, y]);
      const { channel } = await hook(x.id);

      await emitUsurped(a.id, x.id, y.id, new Date(NOW.getTime() - 10 * 60_000));
      const muted = await emitUsurped(a.id, y.id, x.id, new Date(NOW.getTime() - 5 * 60_000));

      await dispatchNotifications(db, { now: NOW, transport: fakeTransport() });

      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channelId, channel.id));

      const suppressed = rows.find((r) => r.eventId === muted);
      expect(suppressed?.status).toBe("suppressed");
      // Zero attempts: nothing was sent, so counting one would misreport the
      // channel's health.
      expect(suppressed?.attempts).toBe(0);
    });

    it("records a failure on the channel so a dead webhook is visible", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const a = await newArena([x, y]);
      const { channel } = await hook(x.id);
      await emitUsurped(a.id, x.id, y.id, new Date(NOW.getTime() - 60_000));

      const summary = await dispatchNotifications(db, {
        now: NOW,
        transport: fakeTransport(true),
      });
      expect(summary.failed).toBe(1);
      expect(summary.sent).toBe(0);

      const [view] = await channelsFor(db, x.id);
      expect(view!.lastError).toContain("500");
      expect(view!.lastDeliveredAt).toBeNull();

      // A failed send must not consume the hour: the *next* usurping still
      // gets a chance, because nothing was actually delivered.
      const next = await emitUsurped(a.id, y.id, x.id, new Date(NOW.getTime() - 30_000));
      const second = await dispatchNotifications(db, { now: NOW, transport: fakeTransport() });
      expect(second.sent).toBe(1);
      expect(second.suppressed).toBe(0);
      void channel;
      void next;
    });

    it("skips a disabled channel", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const a = await newArena([x, y]);
      const { channel } = await hook(x.id);
      await setChannelEnabled(db, x.id, channel.id, false);
      await emitUsurped(a.id, x.id, y.id, new Date(NOW.getTime() - 60_000));

      const transport = fakeTransport();
      expect((await dispatchNotifications(db, { now: NOW, transport })).sent).toBe(0);
      expect(transport.sent).toHaveLength(0);
    });

    it("ignores event types outside the notifiable set", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const a = await newArena([x, y]);
      await hook(x.id);
      await db.insert(events).values({
        arenaId: a.id,
        type: "eliminated",
        actorId: x.id,
        targetId: y.id,
        payload: {},
        createdAt: new Date(NOW.getTime() - 60_000),
      });

      const summary = await dispatchNotifications(db, { now: NOW, transport: fakeTransport() });
      expect(summary.considered).toBe(0);
    });

    it("ignores events older than the lookback window", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const a = await newArena([x, y]);
      await hook(x.id);
      await emitUsurped(a.id, x.id, y.id, new Date(NOW.getTime() - 48 * 60 * 60_000));

      const summary = await dispatchNotifications(db, { now: NOW, transport: fakeTransport() });
      expect(summary.considered).toBe(0);
    });
  });

  describe("visibility", () => {
    it("does not name an anonymous counterparty", async () => {
      const [winner, loser] = [await newUser(), await newUser()];
      const a = await newArena([], "public");
      // The winner is public; the loser competes anonymously.
      await db.insert(arenaMembers).values({ arenaId: a.id, userId: winner.id });
      await db
        .insert(arenaMembers)
        .values({ arenaId: a.id, userId: loser.id, visibility: "anonymous" });

      await hook(winner.id);
      await emitUsurped(a.id, winner.id, loser.id, new Date(NOW.getTime() - 60_000));

      const transport = fakeTransport();
      await dispatchNotifications(db, { now: NOW, transport });

      const payload = transport.sent[0]!;
      expect(payload.actor).toBe(winner.handle);
      expect(payload.text).not.toContain(loser.handle);
      expect(payload.target).toMatch(/^Anonymous /);
    });

    it("withholds a hidden counterparty's name but still tells the recipient", async () => {
      const [winner, loser] = [await newUser(), await newUser()];
      const a = await newArena([]);
      await db.insert(arenaMembers).values({ arenaId: a.id, userId: winner.id });
      await db
        .insert(arenaMembers)
        .values({ arenaId: a.id, userId: loser.id, visibility: "hidden" });

      await hook(winner.id);
      await emitUsurped(a.id, winner.id, loser.id, new Date(NOW.getTime() - 60_000));

      const transport = fakeTransport();
      await dispatchNotifications(db, { now: NOW, transport });

      // The feed drops such an entry entirely. A notification does not: the
      // winner is a party to their own usurping. Only the name is withheld.
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]!.target).toBeNull();
      expect(transport.sent[0]!.text).not.toContain(loser.handle);
      expect(transport.sent[0]!.text).toContain("the previous Sovereign");
    });

    it("names an anonymous recipient to themselves", async () => {
      const [winner, loser] = [await newUser(), await newUser()];
      const a = await newArena([]);
      await db
        .insert(arenaMembers)
        .values({ arenaId: a.id, userId: winner.id, visibility: "anonymous" });
      await db.insert(arenaMembers).values({ arenaId: a.id, userId: loser.id });

      await hook(winner.id);
      await emitUsurped(a.id, winner.id, loser.id, new Date(NOW.getTime() - 60_000));

      const transport = fakeTransport();
      await dispatchNotifications(db, { now: NOW, transport });

      // Anonymity is about the board, not about your own inbox.
      expect(transport.sent[0]!.actor).toBe(winner.handle);
    });
  });

  describe("pruneDeliveries", () => {
    it("drops rows past retention and keeps recent ones", async () => {
      const [x, y] = [await newUser(), await newUser()];
      const a = await newArena([x, y]);
      const { channel } = await hook(x.id);

      const old = await emitUsurped(a.id, x.id, y.id, new Date(NOW.getTime() - 60_000));
      await db.insert(notificationDeliveries).values({
        eventId: old,
        channelId: channel.id,
        status: "sent",
        attempts: 1,
        lastAttemptAt: NOW,
        createdAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60_000),
      });

      const recent = await emitUsurped(a.id, y.id, x.id, new Date(NOW.getTime() - 30_000));
      await db.insert(notificationDeliveries).values({
        eventId: recent,
        channelId: channel.id,
        status: "sent",
        attempts: 1,
        lastAttemptAt: NOW,
        createdAt: NOW,
      });

      expect(await pruneDeliveries(db, NOW)).toBe(1);
      const left = await db
        .select({ eventId: notificationDeliveries.eventId })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.channelId, channel.id));
      expect(left.map((r) => r.eventId)).toEqual([recent]);
    });
  });

  describe("crowning", () => {
    it("notifies a first Sovereign with no target", async () => {
      const x = await newUser();
      const a = await newArena([x]);
      await hook(x.id);
      await db.insert(events).values({
        arenaId: a.id,
        type: EVENT_CROWNED,
        actorId: x.id,
        payload: {},
        createdAt: new Date(NOW.getTime() - 60_000),
      });

      const transport = fakeTransport();
      expect((await dispatchNotifications(db, { now: NOW, transport })).sent).toBe(1);
      expect(transport.sent[0]!.text).toContain("took the Throne");
      expect(transport.sent[0]!.target).toBeNull();
    });
  });

  describe("channel cleanup", () => {
    it("removing a user removes their channels", async () => {
      const x = await newUser();
      const { channel } = await hook(x.id);
      await db.delete(users).where(eq(users.id, x.id));
      createdUsers.splice(createdUsers.indexOf(x.id), 1);

      const left = await db
        .select()
        .from(notificationChannels)
        .where(eq(notificationChannels.id, channel.id));
      // `#10.2` promises deletion actually deletes. A dangling channel would
      // keep POSTing to a webhook after the account is gone.
      expect(left).toHaveLength(0);
    });
  });
});
