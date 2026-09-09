/**
 * Sessions, identities, and handles — `SPEC.md#9` M1.
 *
 * `#8` picks GitHub + Google OAuth: GitHub is the norm for this audience and
 * gives a free identity and avatar. This module is provider-agnostic — it takes
 * an already-verified `OAuthProfile` and does the database half — so adding a
 * provider never touches session logic.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { identities, sessions, users, type User } from "./schema.js";
import { joinGlobalArena } from "./seed.js";

/** Sliding window. Long enough not to nag, short enough to bound a stolen cookie. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Only extend a session if it is more than a day old, so a browsing session
 * does not issue a write per request.
 */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** 32 bytes of CSPRNG — 256 bits, far past guessable. */
const TOKEN_BYTES = 32;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface OAuthProfile {
  /** `github` | `google` | `dev`. */
  provider: string;
  /** The provider's stable, immutable user id — never an email or username. */
  providerUid: string;
  /** Username or login, used to derive a provisional handle. */
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
}

// ── handles ────────────────────────────────────────────────────────────────

/**
 * Names that must not become handles.
 *
 * Every one is either a route we serve or a route we are going to serve, and a
 * user who claims `settings` breaks `/u/settings` for everyone. Reserving them
 * up front is far cheaper than migrating a handle later.
 */
/*
 * Single-character entries below (`u`, `a`) are unreachable via this list —
 * `HANDLE_MIN` rejects them first — and are kept only so the list stays a
 * complete record of route names that must never be claimable, in case the
 * minimum length ever drops.
 */
const RESERVED_HANDLES = new Set([
  "admin", "administrator", "root", "system", "usurp", "support", "help",
  "about", "api", "auth", "signin", "signout", "signup", "login", "logout",
  "settings", "account", "me", "you", "user", "users", "u", "a", "arena",
  "arenas", "board", "boards", "club", "clubs", "org", "orgs", "global",
  "throne", "hall", "halls", "season", "seasons", "duel", "duels", "feed",
  "static", "assets", "public", "favicon", "robots", "sitemap", "null",
  "undefined", "true", "false", "anonymous", "deleted",
]);

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 32;

export type HandleRejection =
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "reserved"
  | "taken";

/** Shape check only — uniqueness needs the database. */
export function validateHandleShape(handle: string): HandleRejection | undefined {
  if (handle.length < HANDLE_MIN) return "too_short";
  if (handle.length > HANDLE_MAX) return "too_long";
  // Deliberately no dots: a handle containing one is indistinguishable from a
  // file extension in a URL, and no leading/trailing separators.
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(handle)) {
    return "invalid_characters";
  }
  if (RESERVED_HANDLES.has(handle.toLowerCase())) return "reserved";
  return undefined;
}

async function handleTaken(db: Db, handle: string, exceptUserId?: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.handle}) = lower(${handle})`)
    .limit(1);
  const found = rows[0];
  if (!found) return false;
  return exceptUserId ? found.id !== exceptUserId : true;
}

/** Full validation, including uniqueness. */
export async function validateHandle(
  db: Db,
  handle: string,
  exceptUserId?: string,
): Promise<HandleRejection | undefined> {
  const shape = validateHandleShape(handle);
  if (shape) return shape;
  return (await handleTaken(db, handle, exceptUserId)) ? "taken" : undefined;
}

/**
 * Turn a provider username into a usable handle.
 *
 * Strips what the shape rules forbid, then appends a numeric suffix until it is
 * free. Falls back to a random handle when nothing usable survives — a GitHub
 * login of all-unsupported characters, or a provider that gives us no username
 * at all.
 */
export async function deriveHandle(db: Db, profile: OAuthProfile): Promise<string> {
  const seed = (profile.username ?? profile.email?.split("@")[0] ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, HANDLE_MAX);

  const base = validateHandleShape(seed) === undefined ? seed : "";

  if (base && !(await handleTaken(db, base))) return base;

  if (base) {
    // Bounded: past a handful of collisions a random suffix is likelier to
    // land than the next integer, and this must not become a scan.
    for (let i = 2; i <= 20; i++) {
      const candidate = `${base}${i}`.slice(0, HANDLE_MAX);
      if (validateHandleShape(candidate) === undefined && !(await handleTaken(db, candidate))) {
        return candidate;
      }
    }
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = `${base ? base.slice(0, 20) : "player"}_${randomBytes(3).toString("hex")}`;
    if (validateHandleShape(candidate) === undefined && !(await handleTaken(db, candidate))) {
      return candidate;
    }
  }

  throw new Error("could not allocate a handle");
}

export type ClaimHandleResult =
  | { ok: true; user: User }
  | { ok: false; rejection: HandleRejection };

/** Set a user's handle, marking it as chosen rather than derived. */
export async function claimHandle(
  db: Db,
  userId: string,
  handle: string,
): Promise<ClaimHandleResult> {
  const trimmed = handle.trim();
  const rejection = await validateHandle(db, trimmed, userId);
  if (rejection) return { ok: false, rejection };

  try {
    const [updated] = await db
      .update(users)
      .set({ handle: trimmed, handleConfirmed: true })
      .where(eq(users.id, userId))
      .returning();
    return { ok: true, user: updated! };
  } catch {
    // The unique index is the real arbiter: two people can pass validation
    // concurrently and only one can win the write.
    return { ok: false, rejection: "taken" };
  }
}

// ── identities ─────────────────────────────────────────────────────────────

export interface SignInResult {
  user: User;
  /** True when this login created the account. */
  created: boolean;
}

/**
 * Resolve an OAuth profile to a user, creating one on first sight.
 *
 * The identity is keyed on `(provider, provider_uid)` — the provider's
 * immutable id. Keying on email would hand over an account whenever someone
 * changes their address, or lets an attacker who can register a recycled
 * address inherit one.
 */
export async function signInWithOAuth(db: Db, profile: OAuthProfile): Promise<SignInResult> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: identities.userId })
      .from(identities)
      .where(
        and(
          eq(identities.provider, profile.provider),
          eq(identities.providerUid, profile.providerUid),
        ),
      )
      .limit(1);

    if (existing) {
      // Refresh the mutable profile bits; never touch the handle, which the
      // user may have deliberately changed.
      const [user] = await tx
        .update(users)
        .set({
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          ...(profile.email ? { emailDomain: emailDomainOf(profile.email) } : {}),
        })
        .where(eq(users.id, existing.userId))
        .returning();
      return { user: user!, created: false };
    }

    const handle = await deriveHandle(tx as unknown as Db, profile);

    const [user] = await tx
      .insert(users)
      .values({
        handle,
        displayName: profile.displayName ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        emailDomain: profile.email ? emailDomainOf(profile.email) : null,
        // Derived, not chosen — drives the one-time confirm prompt.
        handleConfirmed: false,
      })
      .returning();

    await tx.insert(identities).values({
      userId: user!.id,
      provider: profile.provider,
      providerUid: profile.providerUid,
    });

    return { user: user!, created: true };
  });
}

/** `#2` — `email_domain` is what org verification is built on in M4. */
export function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Enrol a brand-new user in the global arena.
 *
 * Separate from `signInWithOAuth` because `#2` makes the global arena
 * **opt-in**: auto-enrolling on account creation would make the board a
 * side effect of signing in, which is exactly what `#10.2` promises it is not.
 * The caller does this only after the user asks.
 */
export async function optInToGlobal(db: Db, userId: string): Promise<void> {
  await joinGlobalArena(db, userId);
}

// ── sessions ───────────────────────────────────────────────────────────────

export interface IssuedSession {
  /** Put this in the cookie. It is not recoverable afterwards. */
  token: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  userId: string,
  options: { userAgent?: string; now?: Date } = {},
): Promise<IssuedSession> {
  const now = options.now ?? new Date();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt,
    createdAt: now,
    lastUsedAt: now,
    // Truncated: enough to tell a phone from a laptop, not a fingerprint.
    userAgent: options.userAgent?.slice(0, 120) ?? null,
  });

  return { token, expiresAt };
}

export interface SessionUser {
  user: User;
  expiresAt: Date;
  /** Set when the sliding window moved and the cookie should be re-issued. */
  refreshedTo?: Date;
}

/**
 * Resolve a session token to its user, or `undefined`.
 *
 * Expired sessions are treated as absent and deleted opportunistically, so an
 * abandoned session does not linger until the sweep runs.
 */
export async function resolveSession(
  db: Db,
  token: string,
  options: { now?: Date } = {},
): Promise<SessionUser | undefined> {
  if (!token) return undefined;
  const now = options.now ?? new Date();
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      tokenHash: sessions.tokenHash,
      expiresAt: sessions.expiresAt,
      lastUsedAt: sessions.lastUsedAt,
      user: users,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (!row) return undefined;

  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return undefined;
  }

  // Slide the window, but only occasionally — a write per page view would make
  // every read a write.
  if (now.getTime() - row.lastUsedAt.getTime() > SESSION_REFRESH_AFTER_MS) {
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await db
      .update(sessions)
      .set({ lastUsedAt: now, expiresAt })
      .where(eq(sessions.tokenHash, tokenHash));
    return { user: row.user, expiresAt, refreshedTo: expiresAt };
  }

  return { user: row.user, expiresAt: row.expiresAt };
}

/** Sign out one session. */
export async function destroySession(db: Db, token: string): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Sign out everywhere — for a "revoke all sessions" control. */
export async function destroyAllSessions(db: Db, userId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}

/** Drop expired sessions. Wired to a pg-boss job alongside the other sweeps. */
export async function pruneSessions(db: Db, now = new Date()): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ tokenHash: sessions.tokenHash });
  return deleted.length;
}

/**
 * Constant-time string compare, for OAuth `state` and similar.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak
 * length; this returns false instead.
 */
export function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
