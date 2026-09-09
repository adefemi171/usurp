"use server";

/**
 * Server Actions for the settings page.
 *
 * These call the same `@usurp/db` functions the `/v1/*` routes do, so the page
 * and the API cannot drift on a rule like the club cap or the org visibility
 * default. Next's Server Actions verify Origin against Host, which combined
 * with the `SameSite=Lax` session cookie is what makes these safe as plain
 * forms with no CSRF token of our own.
 *
 * Every action re-checks the session. An action is a POST endpoint like any
 * other — being reachable only from a page we render is not a control.
 *
 * ── Why these return `void` and redirect ────────────────────────────────────
 * A `<form action={fn}>` requires `void | Promise<void>`; returning a result
 * object needs `useActionState` and a client component. Rather than turn the
 * whole page into one, each action finishes with a redirect carrying a short
 * **code**, which the page maps to a message.
 *
 * A code, not the message itself: a query parameter is attacker-controlled, so
 * echoing arbitrary text from it would let anyone craft a settings link that
 * displays whatever they like. An unrecognized code renders nothing.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  addChannel,
  claimHandle,
  createClub,
  devices,
  getDb,
  joinByInviteCode,
  leaveArena,
  optInToGlobal,
  removeChannel,
  rotateInviteCode,
  setChannelEnabled,
  setVisibility,
  type ChannelKind,
} from "@usurp/db";
import { and, eq, isNull } from "drizzle-orm";
import { currentUser } from "../../lib/session";

/** Codes the page knows how to render. Keep in sync with `MESSAGES` there. */
export type NoticeCode =
  | "handle_saved"
  | "visibility_saved"
  | "left_arena"
  | "joined_global"
  | "club_created"
  | "club_joined"
  | "code_rotated"
  | "device_revoked"
  | "not_signed_in"
  | "not_a_member"
  | "bad_visibility"
  | "not_owner"
  | "device_not_revoked"
  | "handle_too_short"
  | "handle_too_long"
  | "handle_invalid_characters"
  | "handle_reserved"
  | "handle_taken"
  | "club_name_invalid"
  | "too_many_clubs"
  | "invite_invalid_code"
  | "invite_club_full"
  | "invite_already_member"
  | "invite_already_in_org"
  | "channel_added"
  | "channel_removed"
  | "channel_enabled"
  | "channel_disabled"
  | "channel_invalid_target"
  | "channel_duplicate"
  | "channel_not_found"
  | "channel_bad_kind";

function finish(code: NoticeCode, ok: boolean): never {
  redirect(`/settings?${ok ? "ok" : "err"}=${code}`);
}

async function requireSignedIn() {
  const user = await currentUser();
  if (!user) finish("not_signed_in", false);
  return user;
}

export async function updateHandleAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const result = await claimHandle(getDb(), user.id, String(formData.get("handle") ?? ""));
  if (!result.ok) finish(`handle_${result.rejection}` as NoticeCode, false);

  // The handle appears in `/u/<handle>` and on every board row.
  revalidatePath("/");
  revalidatePath(`/u/${result.user.handle}`);
  finish("handle_saved", true);
}

export async function setVisibilityAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const arenaId = String(formData.get("arena_id") ?? "");
  const visibility = String(formData.get("visibility") ?? "");
  if (visibility !== "public" && visibility !== "anonymous" && visibility !== "hidden") {
    finish("bad_visibility", false);
  }

  const result = await setVisibility(getDb(), user.id, arenaId, visibility);
  if (!result.ok) finish("not_a_member", false);

  // Visibility changes what the board and the profile will serve.
  revalidatePath("/");
  revalidatePath(`/u/${user.handle}`);
  finish("visibility_saved", true);
}

export async function leaveArenaAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const result = await leaveArena(getDb(), user.id, String(formData.get("arena_id") ?? ""));
  if (!result.ok) finish("not_a_member", false);

  revalidatePath("/");
  finish("left_arena", true);
}

export async function joinGlobalAction(): Promise<void> {
  const user = await requireSignedIn();

  await optInToGlobal(getDb(), user.id);
  revalidatePath("/");
  finish("joined_global", true);
}

export async function createClubAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const result = await createClub(getDb(), user.id, String(formData.get("name") ?? ""));
  if (!result.ok) {
    finish(result.failure === "too_many_clubs" ? "too_many_clubs" : "club_name_invalid", false);
  }

  finish("club_created", true);
}

export async function joinClubAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const result = await joinByInviteCode(
    getDb(),
    user.id,
    String(formData.get("invite_code") ?? ""),
  );
  if (!result.ok) finish(`invite_${result.failure}` as NoticeCode, false);

  revalidatePath("/");
  finish("club_joined", true);
}

export async function rotateInviteCodeAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const code = await rotateInviteCode(getDb(), user.id, String(formData.get("arena_id") ?? ""));
  if (!code) finish("not_owner", false);

  finish("code_rotated", true);
}

const CHANNEL_KINDS: readonly ChannelKind[] = ["webhook", "slack", "email"];

export async function addChannelAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const kind = String(formData.get("kind") ?? "");
  if (!CHANNEL_KINDS.includes(kind as ChannelKind)) finish("channel_bad_kind", false);

  const result = await addChannel(
    getDb(),
    user.id,
    kind as ChannelKind,
    String(formData.get("target") ?? ""),
  );
  if (!result.ok) finish(`channel_${result.failure}` as NoticeCode, false);

  /**
   * The redirect carries the channel **id**, not the secret.
   *
   * A query parameter ends up in browser history, referrers and any proxy log
   * in front of the app, so the secret itself must never travel that way. The
   * page re-reads it server-side for the owner instead.
   */
  redirect(`/settings?ok=channel_added&reveal=${result.added.channel.id}`);
}

export async function removeChannelAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const removed = await removeChannel(
    getDb(),
    user.id,
    String(formData.get("channel_id") ?? ""),
  );
  if (!removed) finish("channel_not_found", false);

  finish("channel_removed", true);
}

export async function toggleChannelAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  const enabled = String(formData.get("enabled") ?? "") === "1";
  const updated = await setChannelEnabled(
    getDb(),
    user.id,
    String(formData.get("channel_id") ?? ""),
    enabled,
  );
  if (!updated) finish("channel_not_found", false);

  finish(enabled ? "channel_enabled" : "channel_disabled", true);
}

export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const user = await requireSignedIn();

  // Revoke, never delete: `last_seq` is what keeps a captured payload from
  // being replayed after the key is discarded.
  const [revoked] = await getDb()
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(devices.id, String(formData.get("device_id") ?? "")),
        eq(devices.userId, user.id),
        isNull(devices.revokedAt),
      ),
    )
    .returning({ id: devices.id });

  if (!revoked) finish("device_not_revoked", false);

  finish("device_revoked", true);
}
