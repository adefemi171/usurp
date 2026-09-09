# AgentsView analytics and deployment

Usurp remains the identity, sharing, and competition layer. AgentsView is an
optional analytics source, not an always-on dependency.

## Optional local bridge

From the repository on the computer with your coding tools:

```sh
npm run usurp -- sync --agentsview http://localhost:8080
```

The successful bridge URL is saved in the CLI config. Subsequent syncs and
existing session-end hooks import it automatically. `--no-bridge` skips it for
one sync; it does not erase a stored snapshot. Native readers always continue.
For a quick source-only refresh, run `npm run usurp -- sync --bridge-only`.
This does not advance the native-reader sync cursor.
Inspect the complete signed snapshot without uploading using
`npm run usurp -- preview --bridge-only --json`.

Only UTC daily agent/model/token/cost aggregates leave the machine. Project
names, paths, session identifiers, prompts, and code are discarded. The bridge
currently supports AgentsView usage-summary schema 6 and its default session
filters (including one-shot sessions, excluding automated sessions). Match those
filters and UTC in AgentsView when comparing values.

Costs are copied as integer microdollars, without repricing. AgentsView can use
historical API rates or source-reported costs; neither necessarily equals a
subscription bill. Missing model prices remain unavailable, not free. Cursor
selected-model metadata is not evidence of per-call tokens or cost.

Snapshots replace previous snapshots, including downward corrections. They
override native analytics for the same device and covered agent through the
import day; other tools and devices retain native coverage. Later native days
can appear as explicitly labelled native estimates. Don't connect the same
multi-machine AgentsView archive to multiple Usurp devices: aggregate data
cannot identify duplicate conversations across devices.

Original hourly usage is retained, and bridge data never grants rating, streak,
or duel credit. The dashboard uses UTC calendar days (Today, last 7/30 days), not
rolling hours. `/v1/users/:handle` exposes `analytics_series` and `bridge_imports`
for the dashboard; existing `totals`, breakdowns, and `usage_series` describe
native hourly data. `callsAvailable: false` means daily snapshots did not report
calls, sessions, edits, or commits.

## Local browser refresh

For Docker on the same computer as AgentsView, configure the web service:

```dotenv
USURP_AGENTS_VIEW_URL=http://host.docker.internal:8080
USURP_AGENTS_VIEW_DEVICE_ID=<the already-enrolled device ID>
```

Recreate the web container after changing environment variables. Only the
signed-in owner of that device gets **Refresh source**. It imports the latest
available summary; it does not trigger AgentsView's own file collector. Run
AgentsView Sync first if that source is behind. Import failure preserves the
last successful snapshot. Public viewers get **Refresh view** only.

For direct `npm run web`, use `http://localhost:8080`. No bridge URL is accepted
from browser input, and redirects/remote origins are refused. The Docker gateway connection preserves the service's
`localhost` Host header while transporting over `host.docker.internal`.
Cloud deployments should leave both variables unset; `localhost` in a cloud container is not your
laptop. Run the CLI locally with `--api https://your-usurp-domain` to push signed
uploads outbound. Do not expose AgentsView port 8080 to the internet.

## Recommended hosting: Render

Use a paid web service, a background worker, and managed PostgreSQL in the same
region. This matches the existing image and long-running worker without
rewriting them for serverless execution.

| Service | Configuration |
| --- | --- |
| Web | Dockerfile, target `runner`; default image command; health check `/api/health` |
| Worker | Same image; `npm -w @usurp/db run worker` |
| Migration | Web pre-deploy command: `npm -w @usurp/db run migrate` (run once, before new code) |
| Database | Managed PostgreSQL; private connection URL as `DATABASE_URL` on all three |

Set `USURP_BASE_URL` to the final HTTPS domain, generate a production
`AUTH_SECRET`, and configure provider credentials via the platform's secret
settings. Register the exact `/auth/github/callback` and `/auth/google/callback`
URLs with those providers. Never use the development sign-in provider in
production. Enable database backups and verify a restore before inviting users.

Use the provider's current pricing calculator for web + worker + database +
storage. Free/sleeping instances are unsuitable for reliable scheduled jobs.
Railway is a reasonable alternative if you prefer its project-oriented console.
A VPS running Compose also works, but TLS, upgrades, backups, and monitoring
become your responsibility.

References: [Render service types](https://render.com/docs/service-types),
[pre-deploy commands](https://render.com/docs/deploys),
[Render pricing](https://render.com/pricing),
[Railway services](https://docs.railway.com/services).

No hosted services are provisioned by this change.
