# Usurp Connect

A local background service with browser controls. Node.js **22.13 or newer** is
required; no repository, Docker, Electron, or native app installer is required.
macOS/Windows use the OS keychain; Linux needs an unlocked Secret Service keyring.
There is no plaintext device-key fallback.

macOS package installation, browser pairing, keychain persistence, signed fixture
uploads, pause/restart, and revocation are acceptance-tested. Windows/Linux are
experimental pending native platform acceptance tests. Login entry generation and
failure handling have automated tests; a real logout/login cycle is not yet tested.

Install the package from your trusted Usurp deployment's `/connect` page:

```sh
npm install --global https://usurp.onrender.com/downloads/usurp-connect-0.1.0.tgz
usurp-connect
```

For a user-local install without administrator access:

```sh
npm install --prefix "$HOME/.local/share/usurp-connect" https://usurp.onrender.com/downloads/usurp-connect-0.1.0.tgz
"$HOME/.local/share/usurp-connect/node_modules/.bin/usurp-connect"
```

The installation command is available only once that deployment has published
the matching build. This package need not be published to the npm registry.

1. Open the local controls, select your Usurp website, and choose Connect account.
2. Follow the approval link and sign in to the website. Confirm the matching code.
3. Select your readers and/or the optional AgentsView bridge. Approve uploading.
4. Save choices. The first sync starts automatically. Confirm **Last confirmed
   upload** and then open **View my usage**.

The service is separate from the old CLI and desktop preview. It uses
`~/.usurp-connect`, does not silently adopt their credentials, and starts with
no sources selected. Stop any older sync job for the same physical computer
before switching to a separately enrolled device to avoid duplicated history.

## Controls

`usurp-connect` starts/reopens the browser; closing the browser keeps syncing.
`usurp-connect status` reports server/device, last check, and last confirmed upload.
`usurp-connect stop` stops this process; login startup, if enabled, is unchanged.
`usurp-connect serve` runs in the foreground. `start --no-open` runs headlessly.
`--server https://your-usurp.example` selects a deployment; connected devices
must disconnect first before switching. `--port 43128` selects a different
loopback port if 43127 is occupied. `--data-dir PATH` isolates service state.

Optional login startup is available through local controls on macOS (LaunchAgent)
and Linux (systemd user service). It runs on user login, not before login. Windows
currently supports manual background start, not automatic login startup. Keep
Node.js and this installed package at their original paths, or save login startup
again after moving/upgrading them. Disabled/locked keyrings prevent enrollment.

Sync runs approximately every minute while awake, with network failures backing
off to 30 minutes. It retries from local logs; keep source logs until an upload
is confirmed. A no-data check is not labeled as an upload. Revoked devices cannot
upload; disconnect and pair again if appropriate. Pause prevents future uploads
but does not cancel an upload already in flight. Stopping the process cancels it;
retry is deduplicated. No always-on availability is promised while the computer
is asleep, offline, logged out, or the free hosted website is waking up.

Only usage aggregates leave the machine, never prompts, code, file paths, project
names, or session titles. AgentsView is optional at `http://127.0.0.1:8080`.
Its all-time daily summaries are separate from native hourly counters; enabling
it imports all available AgentsView agents, even if a native reader is unchecked.
Costs are estimates/source-calculated, not provider billing records.

The local web UI binds only 127.0.0.1, requires a random per-run bearer token,
rejects foreign Host/Origin requests, and does not enable CORS. Its launch link
contains a local control secret: do not share it. Pairing secrets and device keys
stay in the OS keychain; runtime/preferences are owner-readable only. No public
ports, tunnels, administrator privileges, or GitHub credentials are needed.

Website Refresh view reloads already stored data; use Sync now in local controls
to collect immediately. Remote website-triggered sync is not implemented here.

## Remove

Disable start at login in local controls, disconnect (deletes this service's
keychain key), revoke the device in website Settings, then run
`usurp-connect stop` and `npm uninstall -g @adefemi171/usurp-connect`.
Cloud history is not deleted by uninstalling. Local preferences remain in
`~/.usurp-connect`. Upgrade by stopping the service, reinstalling the versioned
package offered by your deployment, and starting again; consent and keys persist.
