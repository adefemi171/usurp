/**
 * `/settings` — handle, arenas, visibility, clubs, devices.
 *
 * The visibility control is the important thing on this page. `#2` makes
 * per-arena visibility the mechanism that stops an org board being a
 * surveillance board, so an org row says so in plain language rather than
 * leaving `hidden` to be inferred from a dropdown default.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import {
  THRONE_COOLDOWN_MS,
  channelsFor,
  devices,
  getDb,
  membershipsFor,
  revealChannelSecret,
  GLOBAL_ARENA_SLUG,
  ownedOrgs,
  duelsForUser,
} from "@usurp/db";
import { currentUser } from "../../lib/session";
import { emailAuthEnabled } from "../../lib/env";
import { EmailForm } from "../signin/email-form";
import EnrollButton from "./enroll-button";
import { DeleteAccount } from "./delete-account";
import { Organizations } from "./organizations";
import { Duels } from "./duels";
import { ManualImport } from "./manual-import";
import {
  type NoticeCode,
  addChannelAction,
  createClubAction,
  joinClubAction,
  joinGlobalAction,
  leaveArenaAction,
  removeChannelAction,
  revokeDeviceAction,
  rotateInviteCodeAction,
  setVisibilityAction,
  toggleChannelAction,
  updateHandleAction,
} from "./actions";

const VISIBILITY_HELP: Record<string, string> = {
  public: "Named on the board.",
  anonymous: "Shown at your true rank under a stable pseudonym.",
  hidden: "Not on the board at all. You still accrue stats privately.",
};

/**
 * Codes an action may redirect back with.
 *
 * A lookup, not echoed text: the query parameter is attacker-controlled, so
 * rendering it verbatim would let anyone craft a settings link that displays
 * arbitrary content. Unknown codes render nothing.
 */
const MESSAGES: Record<NoticeCode, string> = {
  handle_saved: "Handle saved.",
  visibility_saved: "Visibility updated.",
  left_arena: "You left the arena.",
  joined_global: "You are now competing in the global arena.",
  club_created: "Club created — share its invite code below.",
  club_joined: "Joined.",
  code_rotated: "Invite code rotated. The old one no longer works.",
  device_revoked: "Device revoked. It can no longer submit.",
  not_signed_in: "You are not signed in.",
  not_a_member: "You are not a member of that arena.",
  bad_visibility: "Unknown visibility setting.",
  not_owner: "Only the club owner can do that.",
  device_not_revoked: "That device could not be revoked.",
  handle_too_short: "Handles must be at least 2 characters.",
  handle_too_long: "Handles must be at most 32 characters.",
  handle_invalid_characters:
    "Use letters, digits, underscores and hyphens, starting and ending with a letter or digit.",
  handle_reserved: "That handle is reserved.",
  handle_taken: "That handle is already taken.",
  club_name_invalid: "Club names must be 2\u201348 characters.",
  too_many_clubs: "You already own the maximum number of clubs.",
  invite_invalid_code: "That invite code is not valid.",
  invite_club_full: "That club is full.",
  invite_already_member: "You are already in that arena.",
  invite_already_in_org: "You can only belong to one organization arena.",
  channel_added: "Notification channel added.",
  channel_removed: "Notification channel removed.",
  channel_enabled: "Notification channel enabled.",
  channel_disabled: "Notification channel paused.",
  channel_invalid_target:
    "That target was refused. Webhooks must be https and must not point at a private or link-local address.",
  channel_duplicate: "You already have that channel.",
  channel_not_found: "That channel could not be found.",
  channel_bad_kind: "Unknown channel type.",
  channel_email_not_verified:
    "First link and verify this email under Account security.",
  channel_email_unavailable:
    "Email delivery is not configured on this deployment.",
};

function notice(params: Record<string, string | string[] | undefined>) {
  const ok = typeof params.ok === "string" ? params.ok : undefined;
  const err = typeof params.err === "string" ? params.err : undefined;
  const code = (ok ?? err) as NoticeCode | undefined;
  if (!code || !(code in MESSAGES)) return undefined;
  return { message: MESSAGES[code], ok: ok !== undefined };
}

function ago(date: Date | null): string {
  if (!date) return "never";
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) redirect("/signin?return_to=%2Fsettings");

  const params = await searchParams;
  const welcome = params.welcome === "1";
  const banner = notice(params);

  const db = getDb();
  const [memberships, deviceRows, channels] = await Promise.all([
    membershipsFor(db, user.id),
    db.select().from(devices).where(eq(devices.userId, user.id)),
    channelsFor(db, user.id),
  ]);

  // Only ever read for a channel this user owns, and only when the add action
  // just redirected here with its id.
  const revealId =
    typeof params.reveal === "string" ? params.reveal : undefined;
  const revealed = revealId
    ? await revealChannelSecret(db, user.id, revealId)
    : null;

  const inGlobal = memberships.some((m) => m.arena.slug === GLOBAL_ARENA_SLUG);
  const activeDevices = deviceRows.filter((d) => d.revokedAt === null);

  return (
    <main className="wrap settings-page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1 className="brand">
            Make it yours<span>.</span>
          </h1>
          <p className="tagline">
            Manage your profile, coding devices, and who sees your activity.
          </p>
        </div>
        <div className="row">
          <a
            className="tab"
            href={`/u/${encodeURIComponent(user.handle)}?window=all`}
          >
            View my usage ↗
          </a>
          {/* POST, because a GET sign-out is triggerable by any <img> tag. */}
          <form method="POST" action="/auth/signout">
            <button className="tab" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>

      {welcome && (
        <p className="disclaimer">
          <strong>Welcome.</strong> Your handle was derived from your provider
          profile — confirm or change it below. You are not on any board yet.
        </p>
      )}

      {banner && (
        <p className={banner.ok ? "disclaimer" : "disclaimer error"}>
          {banner.message}
        </p>
      )}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <p className="eyebrow">Preferences</p>
          <a href="#profile">Profile</a>
          <a href="#devices">Devices & sync</a>
          <a href="#arenas">Arenas & visibility</a>
          <a href="#clubs">Clubs</a>
          <a href="#organizations">Organizations</a>
          <a href="#duels">Duels</a>
          <a href="#notifications">Notifications</a>
          <a href="#security">Account security</a>
        </nav>
        <div className="settings-content">
          {/* ── handle ── */}
          <section className="settings-section" id="profile">
            <h2 className="section">Profile</h2>
            {!user.handleConfirmed && (
              <p className="field-hint">
                This handle was generated from your provider profile. Saving it
                below confirms it as yours.
              </p>
            )}
            <form className="form" action={updateHandleAction}>
              <label className="field">
                <span className="field-label">Public handle</span>
                <input
                  className="input"
                  type="text"
                  name="handle"
                  defaultValue={user.handle}
                  required
                  minLength={2}
                  maxLength={32}
                  pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]*"
                />
                <span className="field-hint">
                  Your profile lives at <code>/u/{user.handle}</code>. Letters,
                  digits, <code>_</code> and <code>-</code>.
                </span>
              </label>
              <button className="button" type="submit">
                {user.handleConfirmed ? "Change handle" : "Confirm handle"}
              </button>
            </form>
          </section>

          {/* ── devices ── */}
          <section className="settings-section" id="devices">
            <h2 className="section">Devices & sync</h2>
            <ManualImport />
            <p>
              Connect your computer once, then let Usurp Connect handle syncing.
            </p>
            <a className="button" href="/connect">
              Connect this computer
            </a>
            <p className="field-hint">
              Connect the computer where you code. Device keys stay on that
              machine; Usurp receives only signed usage summaries.
            </p>

            {deviceRows.length === 0 ? (
              <p className="field-hint">No devices enrolled yet.</p>
            ) : (
              <div
                className="table-scroll"
                role="region"
                aria-label="Connected devices"
                tabIndex={0}
              >
                <table className="board">
                  <thead>
                    <tr>
                      <th scope="col">Device</th>
                      <th scope="col">Trust</th>
                      <th scope="col">Last upload</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {deviceRows.map((d) => (
                      <tr key={d.id}>
                        <td className="who">
                          {d.label ?? "unnamed"}
                          <br />
                          <span className="sub">{d.id}</span>
                        </td>
                        <td>
                          <span
                            className={d.revokedAt ? "badge flagged" : "badge"}
                          >
                            {d.revokedAt
                              ? "revoked"
                              : d.trustTier.replace("_", " ")}
                          </span>
                        </td>
                        <td className="num sub">
                          {d.lastSeenAt
                            ? ago(d.lastSeenAt)
                            : d.revokedAt
                              ? "No uploads"
                              : "Registered · awaiting first sync"}
                        </td>
                        <td>
                          {!d.revokedAt && (
                            <form action={revokeDeviceAction}>
                              <input
                                type="hidden"
                                name="device_id"
                                value={d.id}
                              />
                              <button
                                className="button ghost danger"
                                type="submit"
                              >
                                Revoke
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <details className="auth-options">
              <summary>Advanced: connect with the source CLI</summary>
              <p>
                Most users should use <a href="/connect">Usurp Connect</a> for
                automatic background sync without cloning. For source
                development, install Node.js 22 or newer, then run:
              </p>
              <pre>
                <code>
                  {
                    "git clone https://github.com/adefemi171/usurp.git\ncd usurp\nnpm ci\nnpm run build"
                  }
                </code>
              </pre>
              <p>
                Create a one-time code and run its command from that folder.
              </p>
              <div style={{ marginTop: 18 }}>
                <EnrollButton />
              </div>
            </details>

            {activeDevices.length === 0 && (
              <p className="field-hint" style={{ marginTop: 12 }}>
                Nothing will appear on a board until at least one device syncs.
              </p>
            )}
            <details className="auth-options">
              <summary>How to sync your activity</summary>
              <p>
                With Usurp Connect, approve your selected sources and save them
                in the local browser controls. It uploads automatically; use its{" "}
                <strong>Sync now</strong> button for an immediate check.
                Registered does not mean synced: look for a last upload above.
              </p>
              <p>
                Website Refresh view only reloads stored data. It cannot read
                local files or wake an offline computer.
              </p>
              <p>
                Source CLI users can run <code>npm run usurp -- sync</code>, or
                add <code>--all</code> for older history and{" "}
                <code>--agentsview http://localhost:8080</code> for the optional
                bridge.
              </p>
            </details>
          </section>

          {/* ── arenas ── */}
          <section className="settings-section" id="arenas">
            <h2 className="section">Arenas & visibility</h2>
            <p className="field-hint">
              Choose where you compete and how you appear. Each arena has its
              own visibility setting.
            </p>

            {!inGlobal && (
              <div className="empty">
                <h2>You are not competing globally</h2>
                <p>
                  Global membership is opt-in. Joining names you on the public
                  board unless you pick anonymous or hidden afterwards.
                </p>
                <form action={joinGlobalAction} style={{ marginTop: 14 }}>
                  <button className="button" type="submit">
                    Compete in the global arena
                  </button>
                </form>
              </div>
            )}

            {memberships.length === 0 ? (
              <p className="field-hint">No arenas yet.</p>
            ) : (
              <div className="stack">
                {memberships.map((m) => (
                  <div className="card" key={m.arena.id}>
                    <div className="card-head">
                      <div>
                        <a className="who-link" href={`/a/${m.arena.slug}`}>
                          <strong>{m.arena.name}</strong>
                        </a>{" "}
                        <span className="badge">{m.arena.type}</span>{" "}
                        <span className="sub">
                          {m.memberCount}
                          {m.arena.maxMembers
                            ? ` / ${m.arena.maxMembers}`
                            : ""}{" "}
                          members
                        </span>
                      </div>
                    </div>

                    {m.arena.type === "org" && (
                      <p className="field-hint">
                        Org arenas default to <strong>hidden</strong>. Admins
                        see aggregates only unless you set yourself public here.
                      </p>
                    )}

                    <form className="row" action={setVisibilityAction}>
                      <input type="hidden" name="arena_id" value={m.arena.id} />
                      <select
                        className="input select"
                        name="visibility"
                        defaultValue={m.visibility}
                        aria-label={`Visibility in ${m.arena.name}`}
                      >
                        <option value="public">Public — named</option>
                        <option value="anonymous">Anonymous — pseudonym</option>
                        <option value="hidden">Hidden — not listed</option>
                      </select>
                      <button className="button secondary" type="submit">
                        Save
                      </button>
                    </form>
                    <p className="field-hint">
                      {VISIBILITY_HELP[m.visibility]}
                    </p>

                    {m.inviteCode && (
                      <>
                        <p className="field-label" style={{ marginTop: 12 }}>
                          Invite code (owner only)
                        </p>
                        <pre>
                          <code>{m.inviteCode}</code>
                        </pre>
                        <form className="row" action={rotateInviteCodeAction}>
                          <input
                            type="hidden"
                            name="arena_id"
                            value={m.arena.id}
                          />
                          <button className="button ghost" type="submit">
                            Rotate code
                          </button>
                        </form>
                      </>
                    )}

                    {/* Global included: `#10.2` promises every arena is
                  independently leavable, and rejoining is a single click. */}
                    <form action={leaveArenaAction} style={{ marginTop: 10 }}>
                      <input type="hidden" name="arena_id" value={m.arena.id} />
                      <button className="button ghost danger" type="submit">
                        Leave {m.arena.name}
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── clubs ── */}
          <section className="settings-section" id="clubs">
            <h2 className="section">Clubs</h2>
            <div className="two-up">
              <form className="form" action={createClubAction}>
                <label className="field">
                  <span className="field-label">Create a club</span>
                  <input
                    className="input"
                    type="text"
                    name="name"
                    placeholder="Backend crew"
                    required
                    minLength={2}
                    maxLength={48}
                  />
                  <span className="field-hint">
                    Up to 50 members. You get an invite code.
                  </span>
                </label>
                <button className="button" type="submit">
                  Create
                </button>
              </form>

              <form className="form" action={joinClubAction}>
                <label className="field">
                  <span className="field-label">Join with a code</span>
                  <input
                    className="input"
                    type="text"
                    name="invite_code"
                    placeholder="A6BP5S9TKJ"
                    required
                    minLength={4}
                    maxLength={64}
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                  <span className="field-hint">
                    Spacing, dashes and case are ignored.
                  </span>
                </label>
                <button className="button secondary" type="submit">
                  Join
                </button>
              </form>
            </div>
          </section>

          <Organizations
            initial={(await ownedOrgs(getDb(), user.id)).map((o) => ({
              id: o.id,
              name: o.name,
              domain: o.domain,
              verified: !!o.verifiedAt,
            }))}
          />
          {user.reviewState === "shadow_frozen" && (
            <p className="notice" role="status">
              Your rating is paused for usage review. Syncing and private
              analytics still work, but new titles and challenges are paused.
              Contact this deployment’s administrator for review; a pricing
              warning alone never triggers this state.
            </p>
          )}
          <Duels
            initial={(await duelsForUser(db, user.id)).map((d) => ({
              ...d,
              windowStart: d.windowStart.toISOString(),
              windowEnd: d.windowEnd.toISOString(),
            }))}
            arenas={memberships
              .filter((m) => m.status === "active")
              .map((m) => ({ id: m.arena.id, name: m.arena.name }))}
          />
          {/* ── notifications ── */}
          <section className="settings-section" id="notifications">
            <h2 className="section">Notifications</h2>
            <p className="field-hint">
              Get updates when you take or lose the Throne, or a duel changes.
              At most one throne alert per arena per{" "}
              {THRONE_COOLDOWN_MS === 3_600_000
                ? "hour"
                : `${THRONE_COOLDOWN_MS / 60000} minutes`}
              .
            </p>

            {channels.length > 0 && (
              <div
                className="table-scroll"
                role="region"
                aria-label="Notification channels"
                tabIndex={0}
              >
                <table className="board">
                  <thead>
                    <tr>
                      <th scope="col">Channel</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last delivery</th>
                      <th scope="col" />
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((c) => (
                      <tr key={c.id}>
                        <td className="who">
                          {c.kind}
                          <br />
                          <span className="sub">{c.target}</span>
                          {c.lastError && (
                            <>
                              <br />
                              <span className="sub danger">{c.lastError}</span>
                            </>
                          )}
                          {revealed && revealId === c.id && (
                            <>
                              <br />
                              <span className="sub">
                                Signing secret: <code>{revealed}</code> — verify{" "}
                                <code>x-usurp-signature</code> as{" "}
                                <code>
                                  HMAC-SHA256(secret, &quot;{"{timestamp}"}.
                                  {"{body}"}&quot;)
                                </code>
                                .
                              </span>
                            </>
                          )}
                        </td>
                        <td>
                          <span
                            className={c.enabled ? "badge" : "badge flagged"}
                          >
                            {c.enabled
                              ? c.signed
                                ? "signed"
                                : "enabled"
                              : "paused"}
                          </span>
                        </td>
                        <td className="num sub">{ago(c.lastDeliveredAt)}</td>
                        <td>
                          <div className="row">
                            <form action={toggleChannelAction}>
                              <input
                                type="hidden"
                                name="channel_id"
                                value={c.id}
                              />
                              <input
                                type="hidden"
                                name="enabled"
                                value={c.enabled ? "0" : "1"}
                              />
                              <button className="button ghost" type="submit">
                                {c.enabled ? "Pause" : "Resume"}
                              </button>
                            </form>
                            <form action={removeChannelAction}>
                              <input
                                type="hidden"
                                name="channel_id"
                                value={c.id}
                              />
                              <button
                                className="button ghost danger"
                                type="submit"
                              >
                                Remove
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <form
              action={addChannelAction}
              className="row"
              style={{ marginTop: 14 }}
            >
              <select
                className="input"
                name="kind"
                defaultValue="webhook"
                aria-label="Channel type"
              >
                <option value="webhook">Webhook</option>
                <option value="slack">Slack</option>
                <option value="email" disabled={!emailAuthEnabled()}>
                  {emailAuthEnabled()
                    ? "Email (verified address only)"
                    : "Email (not configured)"}
                </option>
              </select>
              <input
                className="input"
                name="target"
                placeholder="https://example.com/hooks/usurp"
                aria-label="Delivery target"
                style={{ flex: 1, minWidth: 180 }}
              />
              <button className="button" type="submit">
                Add channel
              </button>
            </form>
            <p className="field-hint">
              Webhooks use a signing secret shown once when you add the channel.{" "}
              {emailAuthEnabled()
                ? "For email alerts, link and verify the delivery address under Account security first."
                : "Email delivery is not available on this deployment."}
            </p>
          </section>

          <section className="settings-section" id="security">
            <h2 className="section">Account security</h2>
            <DeleteAccount handle={user.handle} />
            {params.email === "linked" && (
              <p role="status">
                Email linked. You can now use that email to sign in to this same
                account.
              </p>
            )}
            {emailAuthEnabled() && (
              <details>
                <summary>Link an email sign-in to this account</summary>
                <p>
                  Verify your email to use it as another way to sign in.
                  Existing accounts are never merged automatically.
                </p>
                <EmailForm linking />
              </details>
            )}
            <footer className="account-security">
              <p>
                Sign out everywhere if you no longer trust a session. Revoking a
                device above stops new submissions but preserves your usage
                history.
              </p>
              <form method="POST" action="/auth/signout?all=1">
                <button className="button ghost danger" type="submit">
                  Sign out of all sessions
                </button>
              </form>
            </footer>
          </section>
        </div>
      </div>
    </main>
  );
}
