# Usurp

A competitive league for AI coding-agent usage. Hold the Throne in a global
arena, your organization, or a private club of friends — and lose it the moment
someone plays better than you.

**Status: M0-M3 complete.** Signed ingest, the Postgres
schema, native readers for Claude Code, Codex, Cursor and VS Code Copilot, the Burn board, the
rating board, the Throne and its feed, shrinking circles, duels, notifications,
share cards,
the per-user drill-down, OAuth sign-in, handles, per-arena visibility, clubs via
invite code, and self-service device enrollment. Hosted GitHub sign-in has been
verified. Passwordless email registration uses one-time codes; configure a Resend
sender and verify delivery before enabling it. Google sign-in is disabled.

**Usurp Connect now has a browser-based local service.** Install the standalone
package offered by your deployment's `/connect` page, approve device pairing,
choose sources, and let it sync in the background. Node.js 22.13+ is required;
repository cloning, Docker, and a signed desktop app are not. See the
[service guide](connect/README.md). The Electron app remains a separate unsigned
preview and is not the recommended installation path.

### GitHub and email access

Public boards need no account. Register or sign in with GitHub, or use an emailed
8-digit code when email delivery is configured. Existing GitHub users should link
their email in **Settings → Account security** before using email sign-in; accounts
are never automatically merged just because their email addresses match.

For email delivery, verify a sending domain in Resend and set `RESEND_API_KEY` and
`AUTH_EMAIL_FROM` in the deployment's secret environment settings. Never commit
these credentials. Codes expire after ten minutes, permit five verification
attempts, and are bound to the requesting browser. Without sender configuration,
the email form stays disabled instead of pretending to send mail.

Connect each laptop once to the same account. Updated clients share a random
installation ID between CLI and Connect on that computer, stored in
`~/.usurp/installation-id`; this is not a hardware fingerprint. Keep it when
re-enrolling the same computer, but do not copy it to a different laptop. Upgrade
and sync all existing laptops: legacy port-only snapshots cannot reliably identify
separate machines until each laptop has uploaded its installation-aware snapshot.
Run one automatic collector per computer. GitHub sign-in and device pairing do
not themselves upload usage; sources still require your approval.

**The rating simulation gate has passed.** It checks that consistency ×
efficiency beats volume across 8 seeds — run `npm run simulate` to reproduce.
The rating engine is wired to the database and seasonal boards.

Internal planning documents and deployment-specific database operations are
maintained privately. This repository includes the application, migrations,
tests, and generic Docker setup needed to build and self-host Usurp.

---

## What actually leaves your machine

Hourly aggregate counters, and nothing else:

```json
{
  "v": 1,
  "device_id": "dev_…",
  "seq": 7,
  "submitted_at": "2026-09-08T13:59:00.000Z",
  "buckets": [{
    "hour": "2026-09-08T13:00:00Z",
    "agent": "claude-code",
    "model": "claude-opus-5",
    "input_tokens": 12043, "output_tokens": 3311,
    "cache_write_tokens": 8100, "cache_read_tokens": 96500,
    "calls": 14,
    "sessions_started": 2, "sessions_completed": 1, "sessions_abandoned": 1,
    "edits_applied": 9, "edits_reverted": 1,
    "commits": 2,
    "cost_micros": 241865,
    "dedupe_key": "sha256(device_id|hour|agent|model)"
  }],
  "sig": "ed25519(device_key, canonical_json(envelope))"
}
```

**Never transmitted:** prompts, completions, code, file paths, repo names,
branch names, cwd, session ids, tool arguments. `commits` is a *count* from
`git rev-list --count --author=<you> --since=<hour>` — no repo identity, no
messages.

Don't take our word for it. `usurp preview` prints the exact set, and
`usurp preview --json` prints the literal bytes:

```bash
usurp preview            # human-readable table
usurp preview --json     # the signed payload, verbatim
```

The bucketing step is where the guarantee is enforced: `Bucket` has nowhere to
put a path, and the wire schema is `.strict()`, so a leak fails validation
rather than shipping.

---

## Quick start — local testing

Needs Node 22+ and Docker.

```bash
# 1. Install and build
npm install
npm run build                    # tsc -b across the workspace
npm test                         # use an isolated database; integration tests reset fixtures

# 2. Bring up Postgres, run migrations, seed the global arena
node scripts/init-env.mjs         # creates .env with unique secrets; never overwrites
docker compose up -d postgres
npm run db:migrate

# 3. Start the API + board
npm run web                      # dev mode, http://localhost:3000

# 4. Mint yourself an enrollment code (M0 stand-in for OAuth)
npm run enroll -- --handle YOURNAME

# 5. Enrol this machine. Generates an ed25519 key, stores it in your OS
#    keychain. The private key never touches disk.
npm run usurp -- login <CODE-FROM-STEP-4>

# 6. Look before you leap, then sync
npm run usurp -- preview
npm run usurp -- sync

# 7. Open the board
open http://localhost:3000
```

If you already have Postgres, Docker Desktop, or OrbStack using host port
`5432`, the example configuration uses `5433` for Usurp. Existing `.env` files
can be fixed by changing both `POSTGRES_PORT` and the port in `DATABASE_URL` to
an unused matching value (for example `5433`).

To make it automatic, install the `SessionEnd` hook — Claude Code then runs
`usurp sync` every time a session ends:

```bash
npm run usurp -- hook install
# then open /hooks once (or restart) so Claude Code reloads its config
```

### Everything in Docker instead

The whole stack, including migrations, in one command:

```bash
node scripts/init-env.mjs         # new installations only
docker compose up -d              # postgres → migrate → web on :3000
docker compose logs -f web

docker compose run --rm enroll --handle YOURNAME   # get a code
docker compose down               # stop;  add -v to also drop the database
```

`docker compose up` runs the `migrate` job to completion before starting `web`,
so the app never serves against a schema it doesn't match.

The database password is required; there is no shared default. Existing installs
must back up their database and rotate the PostgreSQL role and client settings
together. Editing `POSTGRES_PASSWORD` does not change a password in an existing
data volume. Never delete the volume to rotate credentials. Local PostgreSQL is
bound to `127.0.0.1` only.

---

## Real usage

Same as above, minus the local database. Point the CLI at your deployment:

```bash
# On each machine you code from:
npm run usurp -- login <CODE> --api https://usurp.example.com
npm run usurp -- hook install
npm run usurp -- status          # config / key / server, checked separately
```

Set `USURP_API_URL=https://usurp.example.com` to avoid passing `--api` every
time.

Server side, deploy the image and point it at a managed Postgres:

```bash
docker build -t usurp .
docker run -d -p 3000:3000 \
  -e DATABASE_URL='postgres://user:pass@db.example.com:5432/usurp' \
  usurp

# migrations are a separate one-shot, so a rolling deploy can't race them
docker run --rm \
  -e DATABASE_URL='postgres://user:pass@db.example.com:5432/usurp' \
  usurp npm -w @usurp/db run migrate
```

---

## Signing in, and creating a team

### Signing in

Open **`/signin`**. It only offers providers it can actually complete, so an
unconfigured GitHub shows nothing rather than a button that 404s.

**Locally**, the `dev` provider is the quickest path — any handle signs you in
as that account, and the same handle is always the same account:

```bash
docker compose up -d postgres
npm run db:migrate
npm run web              # dev auth works here
# open http://localhost:3000/signin -> "Dev sign-in (local only)"
```

`npm run web:start` runs the production build, where `next start` forces
`NODE_ENV=production` and the dev provider is **off by design**. That is the
gate working, not a misconfiguration.

**For real sign-in**, register an OAuth app with the callback set to exactly
`<your-origin>/auth/github/callback`, then:

```bash
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
# Optional email codes: RESEND_API_KEY and AUTH_EMAIL_FROM
AUTH_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")
USURP_BASE_URL=https://usurp.example.com
```

`AUTH_SECRET` is required in production and must be at least 32 characters — the
process refuses to start without it.

### Creating a team

A "team" is a **club**: invite-only, capped at 50 (`#2`). In the UI:
**/settings → Clubs → Create a club**. You get an owner-only invite code, which
you can rotate if it leaks. Anyone joins from the same page with **Join with a
code** — case, spaces and dashes are ignored.

```bash
curl -X POST localhost:3000/v1/arenas -b cookies.txt \
  -H 'content-type: application/json' -d '{"name":"Platform team"}'
# -> {"slug":"c-platform-team-…","invite_code":"ZR021Y4TF1","max_members":50}

curl -X POST localhost:3000/v1/arenas/join -b cookies.txt \
  -H 'content-type: application/json' -d '{"invite_code":"ZR021Y4TF1"}'
```

The club board is at `/a/<slug>`.

**Orgs are not creatable yet.** `POST /v1/arenas` makes clubs only. An org needs
email-domain verification and aggregate-only admin views (M4); letting anyone
POST one would make the `org_verified` badge meaningless. Use a club for a work
team today.

### Getting on a board

Membership alone shows nothing — a device has to sync. **/settings → Devices →
Add a device** gives a code and the exact command:

```bash
npm run usurp -- login <CODE>
npm run usurp -- sync
```

Global membership is a separate, explicit opt-in (**/settings → Arenas →
Compete in the global arena**), never a side effect of signing in — `#10.2`.
Every arena, including global, is independently leavable and rejoinable.

---

## Where the device key lives

`usurp login` generates an ed25519 keypair on your machine. Only the 32-byte
**public** key is transmitted. The private half is a PKCS#8 PEM that goes
straight to your OS keychain and is never written to `config.json`, never
logged, and never recoverable from the server.

| Platform | Backend | Works out of the box |
|---|---|---|
| macOS | Keychain Services | yes |
| Windows | Credential Manager | yes |
| Linux desktop | Secret Service (libsecret) — GNOME Keyring, KWallet | yes, if a keyring daemon is running |
| Headless Linux, containers, CI, WSL without a keyring | none available | use `USURP_DEVICE_KEY` |

Resolution order is:

1. `USURP_DEVICE_KEY` — a PKCS#8 PEM in the environment
2. the OS keychain (service `usurp`, account `<device_id>`)
3. error: run `usurp login`

The env var wins deliberately: a container has no keychain, and a host that has
both is one where an operator injected a key on purpose.

**On a machine with no keychain**, `usurp login` refuses to store the key rather
than silently writing plaintext to disk. Enrol with `--print-key` instead, and
put the result in your secret manager:

```bash
# stdout is the PEM and nothing else; all commentary goes to stderr
usurp login <CODE> --print-key > device.key
chmod 600 device.key

export USURP_DEVICE_KEY="$(cat device.key)"
usurp sync
```

In CI, store that PEM as a secret and expose it as `USURP_DEVICE_KEY`. In
Compose, `environment: USURP_DEVICE_KEY: ${USURP_DEVICE_KEY}`.

To remove a key from the keychain: `usurp logout`. That clears local state only
— the server-side device row is kept on purpose, because its `last_seq` is what
stops a discarded key's captured payloads from being replayed later. Revoking a
device is a separate, deliberate act.

### Drill-down and the visibility gate

Board rows link to `/u/<handle>`, a visual usage dashboard with summary cards,
a stacked daily chart, proportional attribution treemap, top models, and cache
composition bars. Switch between effective tokens and estimated cost, group by
model or agent, and use the date/model/agent filters together. Click a tile or
legend to filter; inspect chart days with the pointer or keyboard-accessible
slider. Exact token, session, edit, and commit counters remain available in an
expandable table. The public JSON profile includes the same daily model/agent
aggregates as `usage_series`. Unpriced activity is labelled rather than treated
as free usage. Charts show recorded counters, not corrected reader totals.

`/u/<handle>` is served **only** for a user who is `public` in at least one
arena. An `anonymous` member gets a 404, not a redacted page: `#2` promises a
stable pseudonym, and a profile reachable by guessing the handle would undo it.
So the gate is "is this user public somewhere", answered identically for absent,
hidden, and anonymous users — never "does this user exist". The board renders
anonymous rows as plain text rather than a dead link. Same gate on the page and
the JSON endpoint, so neither becomes the way around the other.

### What the signature does and doesn't prove

The `cli_signed` trust tier (`SPEC.md#3.4`) proves **provenance and
continuity** — that a batch came from a registered device, in order, unaltered.
It does **not** prove the numbers are real: the CLI is MIT-licensed and the key
is on the user's machine, so a determined cheater can patch the reader and sign
whatever they like. That is what `org_verified` and the plausibility gates are
for. Signing raises the cost of cheating from "curl a JSON body" to
"reverse-engineer and patch a client", which keeps casual forgery off the board.

---

## Commands

| Command | What it does |
|---|---|
| `usurp login <code>` | Enrol this machine; key goes to the OS keychain |
| `usurp login <code> --print-key` | Print the key to stdout instead (headless) |
| `usurp preview` | Show exactly what `sync` would send |
| `usurp preview --json` | Signed payload JSON (one envelope per line for multi-batch imports) |
| `usurp sync` | Read, bucket, sign, submit |
| `usurp sync --all` | Import all history; buckets older than 90 days are analytics-only |
| `usurp status` | Check config, key, and server independently |
| `usurp hook install` | Install the Claude Code `SessionEnd` hook |
| `usurp hook uninstall` | Remove it |
| `usurp logout` | Forget the device; drop its key from the keychain |

### Import older usage

The first normal sync reads the last 30 days; subsequent syncs re-read a small
overlap. To include older local records, run `npm run usurp -- sync --all` from
the source folder (preview first with `npm run usurp -- preview --all`). Open
your profile and select **All time** to see them by model, agent, and original date.

Buckets older than 90 days are signed as `historical: true`. They remain visible
in analytics but do not contribute to ratings, streaks, or duels. All other
validation still applies. Imports are batched and repeatable without adding the
same device/hour/agent/model twice, and do not advance the regular sync cursor.
Rebuild/restart the server and apply migrations before using this updated CLI.

| Repo script | What it does |
|---|---|
| `npm run build` | `tsc -b` the workspace |
| `npm test` | Full suite (DB tests skip if `DATABASE_URL` is unset) |
| `npm run typecheck` | Force a clean build of the whole graph |
| `npm run db:generate` | Regenerate migrations from `schema.ts` |
| `npm run db:migrate` | Apply migrations + seed the global arena |
| `npm run enroll -- --handle X` | Mint an enrollment code |
| `npm run web` | Next dev server |
| `npm run build:web` | Production build |

---

## API

```
POST /v1/ingest                 signed bucket batch → {accepted, rejected[], flags[]}
POST /v1/devices                redeem an enrollment code, register a pubkey
GET  /v1/arenas/:slug/board     ?window=day|week|month|all &metric=burn|rating
GET  /v1/arenas/:slug/feed      crownings and usurpings, visibility-safe
GET  /v1/halls/longest-reign    permanent hall of fame (#5.1)
GET  /v1/users/:handle          per-user drill-down: by model, by day, by agent
GET  /api/health                liveness + a real database round-trip
```

Pages: `/` (global board), `/a/<slug>` (any arena), `/u/<handle>` (drill-down),
`/halls/longest-reign`, `/settings`, `/signin`.

`/v1/ingest` needs no bearer token: the ed25519 signature already proves the
sender holds the device key, and `device_id` says which key to check. A second
shared secret would be one more thing to store, rotate and leak without proving
anything the signature doesn't.

`metric=rating` is live as of M2, now that the `#4.4` gate passes. It reads
`standings` rather than recomputing — `#6` calls the board "the hottest read
path". Rebuild the rating with:

```bash
npm run recompute            # one-shot: usage_events -> daily_scores -> standings
npm run worker               # the scheduler: recompute every 10 min (#8, pg-boss)
```

In Docker the `worker` service runs it for you.

That is a script, not part of ingest, deliberately: z-scores are
cohort-relative, so one late bucket changes every other user's score for that
day, which cannot sit inside a `SessionEnd` hook's request. `#8`'s pg-boss is
where it belongs, and that is an open item.

### Board titles

| Rank | Title |
|---|---|
| 1 | **Sovereign** — holds the Throne |
| 2 | **Usurper** — next in line, one good week from taking it |
| 3–4 | **Contender** — `#5.2`'s final four |

Withheld below three active members — "Sovereign" of two people is just "the
other one". Feed events are `crowned` (first sovereign) and `usurped` (a
takeover), carrying actor *and* target so each side renders its own sentence.

Titles appear on the **Rating** board only. `#4.1` attaches titles, seasons and
elimination to rating alone, so the Burn board is deliberately title-free —
dressing volume up as achievement is the failure mode `#1` warns about.

---

## Layout

```
packages/protocol   wire schema, canonical JSON, ed25519, pricing, gates
packages/readers    agent transcript readers + hourly bucketing
                    - claude-code.ts     ~/.claude/projects/*.jsonl
                    - vscode-copilot.ts  VS Code / Insiders / VSCodium /
                                         Cursor / Windsurf chat journals
packages/db         Postgres schema, ingest, board queries, migrations
packages/scoring    rating engine + the #4.4 simulation ship gate (pure functions)
packages/cli        the usurp CLI
apps/web            ingest API + Burn board (Next.js)
```

`protocol` is shared by the CLI and the server, so signer and verifier cannot
drift. Nothing outside `readers` knows how a transcript is laid out, which keeps
the reader choice in `SPEC.md#3.1` reversible.

---

## The rating model and its ship gate

`SPEC.md#4` is the actual product: a rating that cannot be farmed by burning
tokens. `#4.4` demands that be **proven, not asserted**, and `#1` says kill the
project if it cannot be. So the gate is runnable:

```bash
npm run simulate                 # the gate; exits non-zero on failure
npm run simulate -- --seeds 8    # check robustness across seeds
npm run simulate -- --tune       # search the weight grid
```

500 synthetic players across the five archetypes `#4.4` names, 3 seasons × 28
days, deterministic by seed. Current result with the adopted weights:

```
archetype          mean pts  median %ile   best   top10  top25   eff tokens
whale_burner          636.5        30.0%  19.8%       0     25  1,807,688,206
efficient_daily       938.7         9.9%   0.0%      50    100     42,395,528
sporadic_genius       199.9        70.0%  60.1%       0      0     20,159,764
streak_farmer          98.7        89.9%  78.2%       0      0         89,718
cache_gamer           486.3        50.0%  36.3%       0      0      5,527,313
```

`whale_burner` carries **43x** the volume of `efficient_daily` and still cannot
reach the top 10%. Passing on 8 of 8 seeds with a +6.1pp margin; 31 of 215
weightings in the grid pass every seed, so it is not one lucky point.

**Keep it in CI.** It is the only thing between a future weight change and
silently shipping a farmable rating.

---

## Two deviations from the spec

**1. `#3.4`'s cache-read gate is replaced.** The spec proposes
`cache_read_tokens <= k * input_tokens`. Measured against real transcripts, that
rejects essentially all legitimate traffic: `input_tokens` is only the
*uncached remainder* of a prompt, so on a warm cache it collapses to single
digits while `cache_read` is the whole conversation prefix — ratios of 8,000:1
and 16,000:1 are normal, and *highest* for the best-behaved users. The gate is
now the context window, which is a real physical ceiling:

```
(input + cache_read + cache_write) / calls  <=  model context window
```

Pinned as a regression test with the observed numbers in
`packages/protocol/src/gates.test.ts`.

**2. The signature covers the whole envelope, not just `buckets`.** The spec's
`sig = ed25519(canonical_json(buckets))` leaves a captured payload replayable
verbatim, with the `UNIQUE dedupe_key` constraint as the only thing absorbing
it. Signing `device_id`, a monotonic `seq`, and `submitted_at` as well costs
nothing and moves replay protection into the crypto.

**3. `#4.2`'s `efficiency_mult` is missing its centre.** `clamp(0.5, 2.0, w1·z1
+ w2·z2 + w3·z3)` over zero-centered z-scores gives the *median* player the 0.5
floor and pins everyone at or below average there, so the multiplier cannot
discriminate across the bottom half of the cohort. Now `clamp(0.5, 2.0, 1 +
Σ wᵢ·zᵢ)`.

**4. `#4.2`'s efficiency signals were both farmable.** Found by the harness, not
by reading:

- `cache_ratio` as specified has no variance (~0.9999 for everyone). Replaced
  with `cache_read / (cache_read + cache_write)` — which turned out to rank the
  *gamer first* (0.9992 vs the intended player's 0.9626), because a high ratio
  is achieved by not writing cache. Now **penalty-only**: high reuse earns
  nothing, low reuse still punishes the re-cacher.
- `yield = commits / effective_tokens` is unbounded as tokens → 0. The
  `streak_farmer` archetype averaged **290.6** commits/MTok against the
  intended player's 18.7, distorting every cohort z-score. Fixed with a
  100k-token volume floor.

Implementation details and deviation notes live in `packages/scoring/src/`.

One more correction to the spec's prose: `#3.4` says the `UNIQUE dedupe_key`
makes replays no-ops. Ingest upserts with `GREATEST()` per counter instead of
`DO NOTHING`, because a session crossing the top of an hour legitimately
*revises* an already-submitted bucket. `DO NOTHING` would drop those
corrections silently; overwriting would let a narrower re-read erase what's
known. Counters only grow as more of an hour is observed, so max-merge is the
only operation that's both correct and idempotent.

---

## Known gaps

### Repairing usage collected by older readers

Codex `input_tokens` includes cached input. Usurp reads active and archived
rollouts, subtracts that portion,
deduplicates repeated usage snapshots, and prices each call before hourly
aggregation. Sol, Terra, Luna and Astra use the reference-rate snapshot and
context bands recorded in `packages/protocol/src/models.ts` (2026-09-09).
No running AgentsView installation is needed. Unknown/internal model IDs,
including `codex-auto-review`, are not assigned a guessed price.

After upgrading both server and CLI, run from the repository root:

```sh
npm run build
npm run usurp -- sync --all --repair
```

This explicit operation replaces only this device's Codex/Cursor aggregates
in one transaction. The original rows are retained in `usage_repair_backups`
(device-scoped; deleted when the device is deleted). Invalid or incomplete
reader snapshots abort without changing history. Normal sync still uses
max-merge; a repaired device refuses older CLI revisions so inflated counters
cannot return. The repair currently supports at most 2000 buckets atomically;
larger histories fail safely, never partially replace. Do not use `--no-git`
for a repair if you want to retain measured commit counts.

### Optional Cursor billing export

For missing native usage, download **your own unfiltered usage** for a continuous
period from Cursor's dashboard. Set `USURP_CURSOR_USAGE_CSV` to that local CSV's
absolute path when running the CLI. The reader accepts timezone-qualified
`Date`/`Timestamp`, `Model`, `Input Tokens`, `Output Tokens`, and `Cache Read`
(or `Cache Read Tokens`), plus optional `Cache Write`. It also accepts the split
headers `Input (w/ Cache Write)` and `Input (w/o Cache Write)`.

The export replaces native call counts between its earliest/latest measured
timestamps, preventing double counting. Keep the export available for future
full repairs. After adding an export to previously synced history, use
`sync --all --repair` to remove the older unattributed buckets as well.
Malformed/missing counters or ambiguous timestamps fail visibly.
`Included` in a Cost column is not interpreted as a zero-dollar model price:
Usurp computes its standard estimate from model/token counts. Exported email
addresses, filenames and session identifiers are never transmitted. No Cursor
credentials are extracted and no AgentsView dependency is introduced.

### Remaining limitations

- **Cursor coverage.** The native reader uses Cursor's read-only `state.vscdb`,
  not transcript tool arguments. It imports positive token records with reliable
  event timestamps. Saved model selections are shown as conversation metadata;
  they are never assigned to earlier calls whose model is missing. Zero token
  placeholders are unavailable usage, not free calls. Missing per-call models
  remain unpriced. Cache breakdown is unavailable in older native records.
- **Copilot cost is notional.** Copilot bills subscription premium requests
  (its records carry `copilotCredits`, not dollars), so `cost_micros` for that
  agent is what the tokens would have cost at the vendor's list API rate. It is
  the only basis on which two agents compare, and `#4.2` scores on tokens, so
  no ranking depends on dollars. All dashboard costs are comparison estimates,
  not subscription invoices.
- **Copilot reports no cache tokens** because it exposes none. That is handled
  rather than papered over: `signals.ts` turns a zero cache total into a `null`
  signal and `zScores` scores a null at the cohort mean, so a Copilot user is
  neither rewarded nor punished on cache reuse.
- **No per-project breakdown**, unlike AgentsView. Deliberate: `#10.1` promises
  no file paths and no project names leave the machine, and `toBuckets()` drops
  `cwd` at that boundary. Per-model and per-agent are both available.
- **Email notifications are not wired up.** Webhook and Slack deliver for real;
  an email channel records a delivery error rather than silently pretending to
  send.
- **Re-enrolling a machine cannot backfill hours another of your devices
  already reported** — ingest refuses them as `duplicate_backfill`, because
  `dedupe_key` is per-device and the same transcripts would otherwise be
  counted twice. A second *real* machine used before usurp was installed on it
  hits the same guard for overlapping hours.
- **`edits_reverted` is an approximation.** A transcript records a user
  *declining* an edit and a failed edit, but not a later `git checkout`. It
  measures "edit that didn't stick at the time".
- **Pricing is a local mirror** (`models.ts`, cached 2026-06-24). Partner
  platforms (Bedrock, Vertex) price differently and are approximated at
  first-party rates. Fine for a leaderboard, wrong for an invoice.
- **`drizzle-kit` carries a dev-only esbuild advisory** (dev-server SSRF,
  GHSA-67mh-4wv8-2f99). It's a devDependency used to generate migrations; not
  fixable without dropping the generator.
- **No auth on the board.** OAuth is M1 (`#9`).

## License

MIT.
