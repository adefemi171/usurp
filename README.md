# Usurp

Track your AI coding-tool usage, compare activity by model and tool, and compete
in seasonal arenas with a public handle.

## Get started

1. Visit your Usurp website and sign in with GitHub or email, when enabled.
2. Open **Connect** and install Usurp Connect using the command shown there.
3. Run `usurp-connect`, approve the device pairing, and select the sources you
   want to share.
4. Confirm the first upload in the local controls, then open **My usage**.

You do not need to clone this repository or run Docker to connect a device.
Usurp Connect requires Node.js 22.13 or newer. See the
[Connect guide](connect/README.md) for installation, controls, and removal.

Public boards can be viewed without signing in. Joining the global arena is a
separate opt-in under **Settings**. You can also create or join a private club.

Use the same account on multiple computers, pairing each computer separately.
Run one automatic collector per computer. Signing in or pairing alone does not
upload usage; you must select sources and approve syncing.

To add email sign-in to an existing GitHub account, link it in
**Settings → Account security** first. Accounts are not automatically merged by
matching email addresses.

## Usage and rankings

- **My usage** shows daily activity by model and coding tool, with filters and
  charts. Native readers support Claude Code, Codex, Cursor, and VS Code Copilot.
- **AgentsView** is an optional local source for additional tools and its
  calculated usage summaries. It is not required for native readers.
- **Burn** compares usage volume. **Rating** combines activity, efficiency, and
  consistency for seasonal competition.
- Eligible Rating members can earn **Sovereign**, **Usurper**, or **Contender**.
  The Hall of Fame records reigns, including those still in progress.

Cost figures are estimates or source-calculated totals, not provider invoices.
Missing usage or pricing is marked unavailable, not treated as zero. Some tools
do not expose complete token or model records.

Refreshing the website reloads stored data. Use **Sync now** in the local
controls to collect new usage. Background syncing requires an awake, connected
computer and an available Usurp server.

## Privacy

Usage uploads contain aggregate counters, not prompts, code, file paths,
project names, or conversation titles. Device signing keys stay on the device,
normally in the OS keychain. A signed upload establishes device provenance;
it does not certify that every reported counter is accurate.

Public identity uses your handle rather than your account's real name. Arena
visibility is configurable, and devices can be revoked in Settings.

## Self-host with Docker

From a checkout of this repository, with Node.js 22.13+ and Docker installed:

```sh
node scripts/init-env.mjs
```

This creates a private `.env` with generated database and session secrets,
without overwriting an existing file. Configure the settings described in
[.env.example](.env.example), then start the application:

```sh
docker compose up -d --build
```

Open `http://localhost:3000`. Compose starts PostgreSQL, applies migrations,
and runs both the web application and background worker. PostgreSQL binds to
localhost on port 5433 by default; choose an unused `POSTGRES_PORT` if needed.
Keep the host-side `DATABASE_URL` port consistent with that setting.

For sign-in, configure:

- `USURP_BASE_URL`: the public origin of your installation.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: your GitHub OAuth app, with
  callback URL `<your-origin>/auth/github/callback`.
- `RESEND_API_KEY` and `AUTH_EMAIL_FROM`: optional email sign-in using a verified
  sending domain.

Keep secrets in the deployment environment, never in Git. Public installations
must use HTTPS. Changing `POSTGRES_PASSWORD` in `.env` does not rotate the
password of an existing database volume.

## Development

```sh
npm ci
npm run build
node scripts/init-env.mjs   # new installations only
docker compose up -d postgres
npm run db:migrate
npm run web
```

Run `npm run worker` in another terminal to process background jobs. Local
development sign-in is disabled in production.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run build:web` | Build the production web app and Connect package |
| `npm run typecheck` | Check the workspace types |
| `npm run typecheck:connect` | Check Connect types |
| `npm test` | Run tests; use an isolated test database, never production |
| `npm run simulate` | Check the rating model's simulation gate |
| `npm run db:migrate` | Apply database migrations |
| `npm run usurp -- preview` | Preview a CLI usage upload |
| `npm run usurp -- sync` | Upload usage from an enrolled CLI device |

Database-dependent tests skip when `DATABASE_URL` is absent. The test runner
loads `.env` if present, so explicitly select an isolated database before testing.

## License

[MIT](LICENSE).
