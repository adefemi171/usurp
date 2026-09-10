# V1 completion verification — 2026-09-10

## Scope

Added organization domain proof and voluntary verified-email membership,
suppressed weekly aggregate reports, duel HTTP/UI flows, manual imports,
account deletion, private-arena access checks, trust filters, moderation,
bounded request bodies, shared rate limits, SSE refresh invalidations and
email notifications. Hardened webhook DNS resolution and private profile/reign
visibility. Added CI with real HTTP and isolated Docker smoke tests.

Authoritative organization usage verification is disabled. DNS ownership is
not a gold usage badge. Shields and bounties are deferred. ROADMAP.md now tracks
deferred work only.

## Checks

- All 619 tests in 58 files passed against a dedicated local test
  database; never against production.
- TypeScript, Connect typecheck and optimized production web/Connect build passed.
- Rating simulation ship gate passed; multi-seed assertions are in the suite.
- Real HTTP test passed: development OAuth, private route rejection, duel
  proposal/acceptance, cross-origin rejection, organization ownership and DNS
  rejection, account confirmation/deletion and session invalidation.
- Browser checks covered settings, invalid DNS proof, incorrect/correct account
  deletion, deletion confirmation and trust-filter navigation.
- Real SSE connection received ready and refresh-only notifications, then closed.
- Clean Docker build, additive migrations, web and worker startup and health
  checks passed. Only disposable test containers and volumes were removed.

External GitHub and email provider authentication were not re-run in this
pass; existing deployment credentials remain unchanged. No authoritative
Anthropic integration was tested or enabled. This is not an independent
security audit or a complete screen-reader certification.

## Pricing maintenance and historical repair

Treat unknown-model and cost-mismatch warnings as an investigation signal, not
evidence of cheating. Inspect the affected model, source and time window first.
For native reader registry changes, check the provider's published rates,
effective dates, context bands and cache policy; add fixtures and run protocol
and reader tests before release. Do not substitute first-party pricing for a
partner-specific bill without clearly retaining estimate provenance.

AgentsView-backed profiles copy source-reported costs without repricing. Refresh
the selected source and sync again to repair stale summaries. Native historical
usage must be re-read on its owning device with `sync --all` after a reader fix;
hourly server totals cannot reconstruct missing request-level context or cache
TTL. The explicit device repair flow is for supported reader corrections only.
Never rewrite old costs using today's list rate. Back up and rehearse any model
identifier re-key, because identifiers participate in deduplication.

## Dependency limitation

`npm audit` reports four moderate development-only advisories through
`drizzle-kit` → `@esbuild-kit/esm-loader` → old esbuild
(GHSA-67mh-4wv8-2f99). The production Docker install reports zero advisories.
The affected esbuild development server is not used by this app. Do not expose
that server or Drizzle Studio. Migration generation runs as a one-shot tool;
the runtime image excludes development dependencies. npm's suggested automatic
fix downgrades Drizzle Kit across incompatible versions and was not applied.
Replace this tooling through a tested upgrade, not `npm audit fix --force`.

## Release boundary

Local checks do not prove that a deployment is live. Confirm the pushed commit,
CI result, Render deployment result and public health/privacy endpoints before
announcing production availability. The new migrations only add tables and
indexes; OAuth, sender credentials and existing usage are not rewritten.
