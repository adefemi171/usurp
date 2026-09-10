# Usurp — v2 roadmap

Updated 2026-09-10. Completed v1 work has been removed at the owner's request. The implemented product and privacy rules remain in SPEC.md. The items below are deferred, not enabled features.

## Shields and bounties

- [ ] Design the banked rating-points economy: earning, spending, limits, rollover, refunds and abuse controls. No money wagers.
- [ ] Define 24-hour anti-dethrone shields: price, cooldown, eligibility, expiry, elimination and moderation interactions.
- [ ] Define bounties: sponsorship, point reservation, cancellation, ties, expiry, self-dealing prevention and payout rules.
- [ ] Build an audited transactional points ledger with idempotent settlement.
- [ ] Extend the simulation ship gate to cover the new incentives and farming strategies.
- [ ] Add accessible controls, expiry indicators and clear explanations of point commitments.
- [ ] Test season boundaries, concurrent requests, account deletion, membership changes and notifications.

## Authoritative organization verification

This remains disabled until the prerequisites and live validation exist. DNS ownership and verified work email establish membership, not authoritative usage.

- [ ] Obtain a consenting Anthropic API organization, an Admin API credential and reliable member-to-API-key attribution.
- [ ] Validate authoritative usage and cost reconciliation, including shared keys, delayed billing and privacy boundaries.
- [ ] Implement encrypted credential storage, scoped access, rotation and revocation.
- [ ] Enable the gold verification tier only after a successful live integration test.

## Later, evidence-driven improvements

- [ ] Integrate actual provider billing and credits where supported, with explicit consent and source provenance. Never infer a subscription invoice from token counts.
- [ ] Replace the legacy Drizzle migration-tool dependency chain with a tested supported upgrade; see the development-only advisory in docs/verification-2026-09-10.md.
- [ ] Introduce materialized Burn aggregates only if measured query performance warrants them; preserve visibility and deletion semantics.
- [ ] Obtain independent security and assistive-technology reviews before organization-wide rollout.
- [ ] Revisit native installers only if local browser-based Connect proves insufficient and signing/notarization credentials are available.

V2 requires a separate design-and-build pass. Existing simulation, privacy, HTTP and Docker tests remain release gates.
