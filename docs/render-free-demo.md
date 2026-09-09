# Render free demo

This is a small community preview, not reliable always-on production hosting.

## Services

- One Free Docker web service, repository root as build context.
- One Free PostgreSQL 17 database in the same region (Oregon).
- Docker command: `node scripts/render-demo.mjs`.
- Health check: `/api/health`.
- No pre-deploy command (not supported on free compute). The demo entrypoint
  applies migrations before starting the web server and scoring worker.
- Only one app instance. Web and worker share its resource allowance. If either
  exits unexpectedly, the supervisor stops the other so Render can restart it.
- Rankings recompute every two minutes while the service is awake, and on
  startup. Sleeping instances run no jobs. This does not bypass free-tier sleep.

## Runtime configuration

- `DATABASE_URL`: private connection URL of the Render database.
- `AUTH_SECRET`: generated secret, at least 32 characters.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: a deployment-specific OAuth app.
- `DATABASE_POOL_MAX=3` to limit connections on the small instance.
- `NODE_ENV=production` and `PORT=10000`.
- Leave `USURP_BASE_URL` unset to use Render's `RENDER_EXTERNAL_URL`, or set it
  to your HTTPS custom domain.
- Never set `USURP_DEV_AUTH`. Leave cloud AgentsView bridge variables unset.

Register GitHub's callback as `https://<service>.onrender.com/auth/github/callback`.
Keep local OAuth credentials separate so local sign-in keeps working.

## Joining and syncing

1. Sign in with GitHub, confirm your handle, and opt into the global arena in
   Settings. Signing in alone never publishes your activity.
2. Clone the repository locally, install Node 22+, run `npm ci` and
   `npm run build`. You do not need a local server or database.
3. Choose **Add a device** and run its generated login command. It includes
   `--api` with the hosted address so uploads cannot accidentally go to localhost.
4. Run `npm run usurp -- sync --all` for history, and `npm run usurp -- sync`
   for fresh activity. An optional local AgentsView URL can be supplied with
   `--agentsview http://localhost:8080`. Never expose port 8080 publicly.
5. The board offers opt-in, one-minute auto-refresh while visible. New activity
   still requires a local sync; rankings wait for the worker. This is periodic
   refresh, not an instantaneous live stream.

The cloud database starts empty. Local accounts, cookies, device enrollment,
and data do not automatically move to the hosted instance. Use a separate
`USURP_CONFIG_DIR` when testing both deployments from one computer.

## Limits and data retention

Render Free web services sleep after 15 minutes without inbound traffic and
may take about a minute to wake. Free database storage is 1 GB, and the database
expires 30 days after creation. It has no managed backups. Export important
data or move to persistent paid hosting before expiry; after the grace period,
Render deletes expired databases. No paid services or automatic upgrades are
part of this setup.

The workspace shares 750 free instance hours each month across all free web
services. Bandwidth and build minutes also have limits; an existing payment
method can permit overage charges under Render's account policy. Review the
workspace's usage and spend limits before broader promotion.

Source: [Render free-tier limitations](https://render.com/docs/free).
