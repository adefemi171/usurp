# Usurp — local only

Track AI coding-tool usage, estimated cost, coaching experiments and signed checks
on your own computer. No Render account, GitHub OAuth app, email provider or public
deployment is needed. The hosted service is being retired.

## Start locally

Install Docker and a supported patched Node runtime (see `package.json`). From
this checkout:

```sh
npm run local:setup
npm run local:up
```

Open [the local dashboard](http://localhost:3000/signin). Use
`USURP_LOCAL_PASSWORD` from the private `.env.local` file. Setup generates random
owner, database and session secrets without overwriting `.env` or an existing
`.env.local`. Never publish these files or share the password.

The first build downloads images and dependencies. After that, start offline:

```sh
npm run local:start
npm run local:status
npm run local:stop
```

PostgreSQL, migrations, dashboard and scoring worker all run on this computer.
The dashboard binds to `127.0.0.1:3000`; PostgreSQL binds to `127.0.0.1:5433`.
Data lives in `usurp-local_pgdata` and survives stopping/restarting. Never use
`down --volumes` unless you intend to erase it. Do not expose the dashboard
through public ports, tunnels or reverse proxies.

## Collect usage

Open [Connect](http://localhost:3000/connect), install its locally served package,
and run `usurp-connect --server http://localhost:3000`. Pair with your local
account, select sources and approve local syncing. No source is selected for you.
Native readers support Claude Code, Codex, Cursor and VS Code Copilot.
[AgentsView](https://github.com/kenn-io/agentsview) is an optional local source.

Upgraded Connect pauses old hosted pairings and rejects remote upload addresses.
Disconnect the old pairing, then pair locally. Identity and consent are never
silently redirected to a new database. Stop old installed collectors before
upgrading; run only one collector per computer.

The dashboard, collection, estimated pricing, scoring and local test proofs work
without internet after installation. Commands you explicitly run as checks may
need their own network. Optional GitHub PR verification needs GitHub; offline
tests do not. Email, Slack and webhook delivery are disabled in the local stack.
The existing Global and outcome arenas show this installation's data only,
not an online competition. Estimated costs are not provider invoices.

## Data and verification

This installation starts fresh. Hosted history is not automatically downloaded,
merged or restored. The owner's retirement decision is to delete old hosted data
and its backup copies, rather than migrate it.

See [Connect controls](connect/README.md) and
[offline outcomes](connect/OUTCOMES.md). Local signatures authenticate their
reporter, not independent task quality. Experiments compare observed check times
and pass rates; they are not causal evidence, RL or measured AI cost savings.

## Development

```sh
npm ci
npm run typecheck
npm run typecheck:connect
npm run build:web
```

Run tests with an explicitly isolated `DATABASE_URL`: the test runner can load
an old `.env`. Never run destructive database tests against real user data.
GitHub tests and secret scanning remain available. Automatic hosted outcome
uploads are disabled; the source repository is not a deployment.

## License

[MIT](LICENSE).
