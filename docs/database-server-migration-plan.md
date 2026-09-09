# Usurp: Render-to-server database migration plan

Status: planning only, 2026-09-09. No migration, credential rotation, firewall
change, or production restart has been performed under this plan.

## Scope and findings

Keep the public app at https://usurp.onrender.com. Move only its PostgreSQL
database to a separate Docker Compose project on the server used by Trovara.
Do not change Trovara containers, credentials, volumes, networks, or ports.

- The Render source database is PostgreSQL 17; its free plan expires on
  October 9, 2026.
- Read-only SSH inventory succeeded on September 9 after loading the supplied
  identity into the macOS keychain/agent. Trovara's live PostgreSQL 17 container
  is healthy and binds `127.0.0.1:5433`. Port `15433` was unused at inspection;
  recheck immediately before provisioning.
- The server had 7.6 GiB total RAM, approximately 4 GiB available, 42 GiB free
  on the root filesystem, and 575 MiB swap in use. Existing services include
  Trovara PostgreSQL, its worker, object storage, ClamAV, nginx, and MySQL.
  Firewall rules, backup schedules, and Render-to-server latency still need
  verification. No server resources were created or changed.
- GitGuardian incident 37130443 points to the published Compose password
  fallback, not evidence of the generated Render database password leaking.
- Usurp's local `.env` still specifies the published default password, and its
  running Docker database publishes port 5433 on IPv4 and IPv6 wildcard
  interfaces. Internet reachability has not been established; local/network
  exposure depends on the host, Docker runtime, and network firewalls.

## Phase 0: remediate the password default

1. Review all four GitGuardian locations and relevant history, without logging
   credential values. Establish where any detected credential was actually used.
2. Remove password fallbacks from deployment configuration. Require a supplied
   secret and use nonfunctional placeholders in examples. Validate both the
   local-database and external-database configuration paths.
3. Bind local-development PostgreSQL explicitly to `127.0.0.1`, not wildcard
   interfaces. Do not reuse this local-only binding for Render connectivity.
4. Back up the local database and rotate any database role that actually uses
   the published password. Change the role password and its clients together:
   changing `POSTGRES_PASSWORD` alone does not reset an existing data volume's
   database password. Never delete a data volume to accomplish rotation.
5. Re-scan, add a secret-scanning check, and resolve the incident with evidence.
   Do not blanket-ignore the finding. History cleanup is a separate coordinated
   action if a genuine secret was committed; deletion never replaces rotation.

## Phase 1: read-only server preflight

Obtain a working SSH identity; do not weaken host-key verification or change
server access controls just to get connected.

Inventory Docker projects, container names, published ports, volumes, networks,
host services, all listening TCP ports, CPU load, RAM, swap, and free disk space.
Check the Docker firewall backend, provider firewall, IPv4 and IPv6 rules,
existing backup schedules, and server location/network latency to Render.

Reserve the following only after checking for collisions:

| Resource | Proposed value |
| --- | --- |
| Compose project | `usurp-data` |
| Server directory | `/opt/usurp-data` |
| PostgreSQL version | Supported PostgreSQL 17 patch, image pinned at implementation |
| Container database port | `5432/tcp` |
| Dedicated host database port | `15433/tcp`, provisional until verified unused |
| Data volume | Dedicated `usurp-data` project volume, never Trovara's volume |
| Network | Dedicated bridge network, no attachment to Trovara networks |

Port 5432 inside different containers does not conflict. Host bindings must be
unique. A different port prevents collisions, not unauthorized access.

Set resource and connection limits from measured headroom; leave capacity for
Trovara, OS caches, and backups. Refuse the move if adequate headroom is absent.

## Phase 2: establish secure connectivity

Baseline proposal: a dedicated PostgreSQL TLS endpoint on the server's approved
interface and port 15433, reachable only from the current Render service's
outbound CIDR ranges and any separately approved administration sources.

- Select a database hostname under an owned domain and configure certificates
  and renewal. Require TLS and verify the server certificate chain and hostname.
- Create independent strong credentials and an Usurp-scoped application role;
  never grant access to Trovara. Separate administrative credentials from the
  app. Verify migration and pg-boss schema privileges explicitly.
- Restrict ingress in both the applicable provider firewall and Docker-aware
  host rules. Do not assume a UFW deny rule protects a Docker-published port.
  Do not flush existing rules or disable Docker firewall management.
- Render outbound CIDRs are shared, not an authentication boundary. Retain
  strong database authentication and TLS. Handle IPv6 explicitly as well.
- Test TLS verification for every client: web queries, migrations, and the
  pg-boss worker use different client paths. Do not disable certificate checks.
- Test rejected connections from unauthorized sources, plaintext rejection,
  wrong-password rejection, renewal/reconnect behavior, and Render latency.
- Put secrets only in protected server files and Render secrets, never Git,
  command output, screenshots, or plaintext migration notes.

If a restricted public database endpoint is unacceptable, choose a persistent
private tunnel instead, and validate its Render free-container compatibility,
key isolation, reconnection, and lifecycle before proceeding. This is an
alternative design, not an untested assumption about Render's private network.

## Phase 3: backup and restore rehearsal

1. Inventory source database size, schemas, encoding/collation, extensions,
   migrations, users, devices, signed-upload sequence state, usage, bridge
   snapshots, memberships, ratings, sessions, and pg-boss jobs.
2. Create an encrypted PostgreSQL 17 logical backup and checksum. Keep an
   independent off-server copy; do not commit the dump.
3. Restore into an isolated rehearsal database, mapping ownership and grants
   to the new roles. Account for every application and queue schema.
4. Verify record counts and aggregate totals, constraints, migrations, device
   identities/sequence counters, and representative user access. Rehearsal
   workers must not deliver real notifications or process live jobs.
5. Measure backup/restore time and disk usage before choosing an outage window.
6. Install independent Usurp backup retention, off-server copies, restore
   tests, and failure/storage alerts. Trovara's jobs do not cover Usurp by default.

## Phase 4: controlled cutover

Use a short, explicitly approved maintenance window. Do not copy the database
while continuing to accept writes and assume that snapshot is current.

1. Freeze all Usurp writes: uploads, OAuth callbacks, settings, enrollment,
   arena changes, and worker jobs. Drain in-flight work. The current combined
   Render startup script needs a tested maintenance/worker-stop path first.
2. Capture a final backup after quiescence; restore into the target and repeat
   validation. Never overwrite Trovara data or any unrelated database.
3. Update Render's `DATABASE_URL` and TLS configuration. Keep `AUTH_SECRET`,
   OAuth credentials, and the public URL unchanged. Retain the original
   database securely and prevent writes to both copies simultaneously.
4. Deploy the same tested application/schema version and verify health and
   owner access before reopening writes. Run migrations once in a controlled
   path, with the worker held until schema readiness.
5. Test real GitHub sign-in, private-owner usage access, anonymous rejection,
   enrollment, signed CLI upload/retry/deduplication, bridge snapshot import,
   global opt-in, scoring, and refresh using agreed test accounts/devices.
6. Confirm Trovara's health is unchanged, then reopen Usurp writes and monitor
   connections, latency, errors, memory, disk, and backup success.

## Worker placement

The first cutover keeps the current worker on Render to avoid expanding the
move. It will use the new database and will still stop when Render sleeps.

Optional follow-up: move the worker into its own container on the server's
Usurp network. Change the Render entrypoint to web-only with controlled
migrations, ensure only the intended worker runs, and coordinate application
versions. This supports always-on scoring and reduces cross-provider queue
polling, but it is not part of the database-only cutover without approval.

## Rollback and acceptance

Before new writes are allowed on the target, rollback can restore the old
Render connection and resume the old worker. After target writes begin, simply
switching back would lose new data: freeze writes again and reconcile or restore
the authoritative target back to the old database before reopening traffic.

Keep the old Render database until the new service, backup, and restore test
have been verified and its retirement is explicitly approved. Account for its
October 9 expiration; do not rely on an expired database as a rollback target.

The move is complete only after secure connection tests, actual upload and
scoring checks, privacy checks, restart persistence, backup restoration, and
unchanged Trovara health all pass. A green homepage alone is not acceptance.

## Cost and operating limits

There is no Render database subscription for the replacement, but the existing
server supplies its CPU, RAM, storage, and bandwidth. Backups may have costs.
Render's free web app still sleeps and retains its bandwidth and outbound
traffic restrictions, including traffic to external databases.

## References

- [Render outbound CIDRs](https://render.com/docs/outbound-ip-addresses)
- [Render free-service restrictions](https://render.com/docs/free)
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
- [Docker firewall interactions](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
- [PostgreSQL 17 TLS configuration](https://www.postgresql.org/docs/17/ssl-tcp.html)
