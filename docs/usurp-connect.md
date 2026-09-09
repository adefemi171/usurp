# Usurp Connect desktop preview

The recommended installation flow now uses the [local browser service](../connect/README.md),
not an Electron installer. `npm run build:connect` bundles a standalone package
under `apps/web/public/downloads`; the Docker build includes it, and `/connect`
provides deployment-specific installation commands. This document describes the
older Electron preview, which remains available for development but is not released.

The desktop companion replaces repository cloning for end users once signed
installers are released. It reuses Usurp's existing readers and signed ingest;
it does not replace or require AgentsView.

## User flow

1. Visit `/connect` from **Settings → Connect this computer**.
2. Install the appropriate released companion, or open an existing installation.
3. Choose the deployment's website in the companion and connect the account.
4. Sign in in the browser and compare the displayed pairing code before approval.
5. Choose native sources, optionally AgentsView, and the history window. Explicitly
   allow sync. Connecting alone never starts collection or joins a public arena.

GitHub/Google credentials remain deployment-side. The companion does not contain
OAuth secrets or request the account's password. Only configured providers appear.

## Pairing and privacy

- A fresh Ed25519 key is saved in the OS keychain before pairing. The browser
  approves that specific public key, not a mutable device identity.
- Requests expire after ten minutes. The database stores hashed codes and
  polling tokens. Polling secrets and private keys never enter the renderer,
  browser URL, application logs, or JSON config files.
- Approval is authenticated and uses Next.js Server Action origin/CSRF defenses.
  Transactions serialize decisions. Cancellation cannot discard an approved key.
- Polling is limited to once per five seconds per request. A database-backed
  global budget caps live requests at 500 across replicas. Deploy an edge rate
  limit for larger/public deployments; the global budget alone is not full DDoS
  protection. Requests have a 1 KiB streaming body limit.
- Device keys and resumable pairing secrets use the OS keychain. There is no
  plaintext fallback. Linux needs a working Secret Service session.
- The Electron renderer is sandboxed, has no Node integration, and receives only
  narrow IPC methods. Main-frame/sender validation and a restrictive CSP prevent
  renderer access to secrets, files, remote content, or arbitrary shell commands.
- A custom link only proposes a deployment origin and requires confirmation.
  It cannot authenticate or trigger a sync. Remote deployments require HTTPS;
  explicit localhost HTTP is supported for development.

## Sync behavior

Native sources are Claude Code, Codex, Cursor and VS Code Copilot. Unselected
readers are not even detected. Git scans are disabled in the companion. The
optional bridge imports all available AgentsView agents from `127.0.0.1:8080`.
Cursor metadata and source-calculated prices retain their existing limitations;
Connect cannot manufacture missing usage or turn estimates into invoices.

An isolated utility process reads selected sources and sends signed summaries.
Sync runs roughly every minute, with exponential backoff capped at 30 minutes.
Only one sync runs at a time. Accepted batch sequence progress is retained after
partial failures; rejected batches do not advance the native sync cursor.
The app re-reads retained source logs on retry. There is **no independent durable
upload spool yet**: removing source logs before a successful sync can lose data,
and the normal incremental reader horizon remains 90 days. All-history import
can recover older retained records as analytics-only history.

Closing the window keeps the tray app running. Quit stops it. Pause prevents
new syncs but allows an in-flight request to finish. Installed macOS/Windows
builds support opt-in start at login. Disconnect removes the local key; revoking
the device on the website invalidates any copies. Uploaded history is not deleted.
The companion uses its own application-data directory, separate from `~/.usurp`.

## Development and tests

From the repository root, install the workspaces and build them. Then:

```sh
cd desktop
npm ci
npm run typecheck
npm start
```

`npm run pack` produces a **local test build**, not a distributable signed
release. Desktop dependencies have a separate lockfile and are excluded from
the Render Docker context. End users do not run these developer commands.

The repository Vitest suite includes pairing transactions, expiry, revocation,
cancellation/approval races, API size/error limits, return-path handling, source
consent, and rejected sync behavior. Run integration tests only against an
isolated database: existing suites truncate shared fixture tables.

`desktop/test/e2e.mjs` uses a test website at localhost:3107 with developer sign-in
enabled **only locally**, an isolated database, the actual Electron window and OS
keychain, and synthetic Codex logs. It checks pairing across restart, first-time
sign-in, approval, an injected offline failure with automatic retry, exact signed
upload totals, profile display, pause and disconnect. The test
harness substitutes fixture paths; production code does not accept reader paths
from its renderer. `CONNECT_ELECTRON_EXECUTABLE` optionally selects a verified
local Electron binary for this test. No real coding conversations are uploaded.

`desktop/test/browser.mjs` independently tests browser approval, signed ingest,
replay rejection, owner/anonymous visibility, no automatic global membership,
and revocation. `desktop/test/packaged.mjs` smoke-tests the local macOS package
and its bundled native keychain dependency with temporary credentials.

Verified locally on September 9, 2026: 532 regression tests, web production
build, desktop typecheck, and the desktop/browser flows above. macOS public
release signing is unavailable; the operator does not have an Apple Developer
account. No paid account or service has been created.

## Public release gate

Public installers are not published merely because source builds pass. On each
target OS, verify native keychain/readers, installation, launch-at-login, protocol
handling, upgrades, offline recovery, and removal. Windows/Linux and signed
update installation need their own platform acceptance runs.

For macOS, provision a Developer ID signing identity (`CSC_LINK` or `CSC_NAME`)
and notarization credentials through protected CI secrets. Supported notarization
inputs are `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or the Apple
API-key variables documented by electron-builder. Never commit these credentials.
Windows release signing requires an appropriate signing identity too.

`npm run release` refuses missing credentials, forces signing, and never publishes
automatically. Signed macOS builds enable the fixed GitHub update feed, with
explicit download/restart actions. Unsigned preview and Linux builds only open
the release page; Windows automatic updating is not enabled in this version.

After signed artifacts are uploaded to a versioned GitHub Release and independently
verified, configure only the tested platform URLs on the web service:

- `USURP_CONNECT_MAC_ARM64_URL`
- `USURP_CONNECT_MAC_X64_URL`
- `USURP_CONNECT_WINDOWS_URL`
- `USURP_CONNECT_LINUX_URL`

Only URLs under `https://github.com/adefemi171/usurp/releases/download/` are
accepted. Without a verified release URL, the website states that the platform
has not been released and keeps the CLI available as the interim advanced path.
