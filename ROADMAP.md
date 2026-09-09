# Usurp — Roadmap

Derived from [`SPEC.md#9`](SPEC.md), with the state of each item as of
**2026-09-09**. `#n` references are spec sections.

The spec's own framing governs the order: **`#2` (three scopes) and `#3` (real
elimination) are the hook; `#4` (unfarmable rating) and `#3.4`/`#2` (anti-cheat
+ org privacy) are the product.** M2 is therefore the milestone that decides
whether this ships at all — see [Kill criteria](#kill-criteria).

---

## Status at a glance

| Milestone | Scope | State |
|---|---|---|
| **M0 — Ingest** | Payload schema, ed25519 device keys, Claude Code reader, hourly bucketing, Postgres schema, Burn board | ✅ **done**, verified end to end incl. Docker |
| — *(unplanned)* | Per-user drill-down `/u/<handle>` + visibility gate | ✅ done |
| **M1 — Parity** | OAuth, handles, visibility modes, clubs via invite code | ✅ **done** (GitHub/Google untested against live providers — see note) |
| **M2 — Rating** | Scoring engine, **simulation ship gate**, decay, Throne/reigns, feed | ✅ **done** |
| **M3 — Battle royale** | Seasons, shrinking circles, duels, notifications, share cards | ✅ **done** |
| **M4 — Org** | Domain verification, admin consent, aggregate-only views, Admin-API cross-verification, more agents | 🟡 **VS Code Copilot reader done** (pulled forward: 46% of measured spend); org work not started |

**Current totals:** 429 tests, typecheck clean, 0 non-dev advisories.
**Ship gate:** `npm run simulate` — **PASSING** on 8 seeds.

---

## Open decisions

All four are now resolved in code **and folded back into `SPEC.md`** as
`Amended` notes, so the spec no longer describes rules the implementation
contradicts. They are kept here because the reasoning is the useful part: each
was a plausible-looking rule that real data overturned, and the next plausible
rule deserves the same suspicion.

### 1. `#3.4`'s cache-read gate — ✅ resolved, deviation documented

The spec's `cache_read_tokens <= k * input_tokens` rejects essentially all real
traffic, because `input_tokens` is only the *uncached remainder* of a prompt.
Measured ratios of 8,000:1 and 16,000:1 are normal and are *highest* for the
best-behaved users. Replaced with the context window, a real physical ceiling.
Regression-tested against observed values in `packages/protocol/src/gates.test.ts`.

**Action:** ✅ folded into `SPEC.md#3.4` (2026-09-09), with the measured
8,428:1 ratio recorded so the original mistake stays visible.

### 2. Envelope signing — ✅ resolved, deviation documented

The spec's `sig = ed25519(canonical_json(buckets))` leaves a captured payload
replayable verbatim. Now signs `device_id` + monotonic `seq` + `submitted_at` +
buckets. **Action:** ✅ folded into `SPEC.md#3.3` (2026-09-09) — the payload
example now shows `v`/`seq`/`submitted_at` inside the signed material.

### 3. `#4.2`'s `cache_ratio` signal — ✅ resolved by the harness

Settled by simulation rather than argument, and the answer was not the one I
proposed. Three separate defects, all found by the `#4.4` harness:

**a. `cache_ratio` as specified has no variance.** `cache_read / (input +
cache_read)` pins to ~0.9999 for every competent user. Replaced with
`cache_read / (cache_read + cache_write)`.

**b. That replacement is still farmable — it ranks the gamer first.** Measured
over a simulated cohort: `cache_gamer` 0.9992 > `sporadic_genius` 0.9741 >
`efficient_daily` 0.9626 > `whale_burner` 0.6301. It isolates the whale, but
among honest users it is *inverted*, because a high ratio is achieved by not
writing cache — which is what someone with nothing to do looks like. Now
**penalty-only** (`min(0, z)`): high reuse earns nothing, low reuse still
punishes the re-cacher. You cannot earn rating by not working.

**c. `#4.2`'s `yield` is unbounded as tokens → 0.** `streak_farmer` averaged
**290.6** commits/MTok against `efficient_daily`'s 18.7, on ~1,074 tokens/day —
and because z-scores are cohort-relative, that heavy tail compressed every real
user's yield score. Fixed with a `YIELD_VOLUME_FLOOR` of 100k effective tokens,
which leaves real users untouched.

**Weights adopted:** `cacheReuse=0.05, yieldPerMTok=0.2, completion=0.1` —
yield-led, because yield is the only signal a gamer cannot fake without doing
the work.

### 4. `#4.2`'s `efficiency_mult` is missing its centre — ✅ resolved

`clamp(0.5, 2.0, w1·z1 + w2·z2 + w3·z3)` over zero-centered z-scores gives the
**median player the 0.5 floor**, and pins everyone at or below average there —
so the multiplier cannot discriminate across the bottom half of the cohort at
all:

```
z = (0,0,0)    -> 0.500   median player, minimum multiplier
z = (-1,-1,-1) -> 0.500   indistinguishable from median
z = (+1,+1,+1) -> 1.000
```

Now `clamp(0.5, 2.0, 1 + Σ wᵢ·zᵢ)`, so the median is neutral at 1.0.

**Action:** ✅ folded into `SPEC.md#4.2` (2026-09-09), including the adopted
weights and the missing-signal rule.

---

## M1 — Parity

> *`#9`: OAuth, handles, visibility modes, clubs via invite code. Usurp now
> matches ccclub.*

### Done

- [x] `sessions` table — opaque tokens, SHA-256 at rest, sliding 30-day window
      (migration `0001`, applied)
- [x] `users.handle_confirmed` — distinguishes a derived handle from a chosen one
- [x] `packages/db/src/auth.ts` — session create/resolve/destroy, prune,
      `signInWithOAuth` keyed on `(provider, provider_uid)`, handle derivation
      from a provider profile, `claimHandle`, reserved-handle list
- [x] `packages/db/src/arenas.ts` — `createClub`, `joinByInviteCode` (row-locked
      so the 50-member cap can't be raced), `setVisibility`, `leaveArena`,
      `membershipsFor`, `rotateInviteCode`
- [x] **`#2` invariant in code:** `defaultVisibilityFor()` — org membership
      defaults to `hidden`, set per-type at join time rather than by a column
      default that would silently opt org members into being individually ranked

- [x] **OAuth** — authorization-code flow with `state` in an HMAC-signed
      HttpOnly cookie, and PKCE `S256` where the provider supports it (Google
      yes; GitHub's classic OAuth Apps ignore it, so it is declared per-provider
      rather than assumed). `GET /auth/:provider`, `GET /auth/:provider/callback`,
      `POST /auth/signout` (+ `?all=1`)
- [x] **`dev` provider** at `/dev-signin`, gated on `USURP_DEV_AUTH=1` **and**
      `NODE_ENV !== production`. Its own top-level path, because a static
      `auth/dev/` directory would shadow `auth/[provider]`
- [x] Session cookies: HttpOnly, `SameSite=Lax`, `Secure` derived from the
      configured origin, `AUTH_SECRET` required in production
- [x] Handles: `PATCH /v1/me`, reserved list, case-insensitive uniqueness,
      one-time confirm prompt driven by `handle_confirmed`
- [x] Visibility: `PATCH /v1/me/arenas/:id` (set or leave) + `/settings` UI with
      an explicit org warning
- [x] Clubs: `POST /v1/arenas`, `POST /v1/arenas/join`, owner-only invite code
      reveal and rotation
- [x] **Self-service enrollment:** `POST /v1/me/enrollments` — the operator
      script is no longer in the signup path
- [x] `GET /v1/me`, device list, `DELETE /v1/me/devices/:id` (revoke, not delete)
- [x] Global arena opt-in as an explicit action, not a signup side effect
- [x] 61 new tests: session lifecycle, handle rules, club cap raced
      concurrently, org single-membership, rejoin-resets-to-hidden

### Fixed after review

- [x] **Global was not leavable, and could not be rejoined.** `#10.2` promises
      every arena is independently leavable, but the settings page gated the
      Leave button off for global. Worse, `joinGlobalArena` used
      `onConflictDoNothing` while leaving records `status = 'left'` (a delete
      would break `#6.2`'s append-only history) — so anyone who *did* leave via
      the API could never rejoin: every opt-in hit the existing row, changed
      nothing, and silently left them out. The upsert now reactivates, guarded
      by `setWhere: status = 'left'` so re-opting-in cannot quietly un-hide a
      current member who chose `hidden`. Three regression tests.

### Remaining in M1

- [ ] **Verify GitHub and Google against the live providers.** The flow is
      built and exercised end to end through the `dev` provider — including
      every `state`/CSRF rejection path — but the two real providers have never
      been run, because that needs registered OAuth apps and a public callback
      URL. Treat their `fetchProfile` shapes as unverified until someone does.
- [ ] Rate-limit `/auth/*` and `/v1/me/enrollments`
- [ ] Concurrent-claim test for handles (the unique index is the arbiter; the
      race is untested)

---

## M2 — Rating *(the differentiator — do not skip to M3)*

> *`#4.4`: the optimal strategy to hold the Throne is consistency × efficiency,
> never volume. **This must be proven, not asserted.***

- [x] Scoring engine per `#4.2` (`packages/scoring`): log-scaled volume,
      efficiency multiplier, streak multiplier, `#4.3` decay
- [x] Cohort z-scores, with the two edge cases that decide fairness: zero
      variance → 0 for everyone, and a *missing* signal treated as the cohort
      mean rather than worst-in-cohort (otherwise "start a session and abandon
      it" beats "don't start one")
- [x] **Open decision #3 resolved** — see above
- [x] Engine wired to the database (`rating.ts`): `usage_events` → aggregate
      per user per **UTC** day → `daily_scores`, keyed `(user_id, day)` per `#6`
- [x] `standings` refreshed transactionally under the **per-arena advisory
      lock** `#6.1` specifies. Tested with three concurrent recomputes
      producing exactly one open reign
- [x] Decay `#4.3` — and season totals are **replayed day by day, not summed**,
      because decay is path-dependent: the same daily scores in a different
      order give a different total, so a `SUM()` would silently delete the
      mechanic that makes a throne contestable
- [x] Throne + `reigns`, append-only per `#6.2`: old reign closed with
      `ended_by_user_id`, new one opened, `crowned` / `usurped` emitted. A
      zero-point leader gets **no** throne — a throne has to be won
- [x] `GET /v1/arenas/:slug/board?metric=rating` — live, with `#2` visibility
      applied (hidden absent, anonymous pseudonymous at their true rank)
- [x] Seasons (`seasons.ts`): contiguous 4-week windows with no gaps, so
      activity can never score into nothing
- [x] Board titles (`titles.ts`) — see below
- [x] Rating board **UI** — metric toggle (Rating | Burn), title badges, season
      countdown, rank movement. Titles render on rating only, per `#4.1`
- [x] **Solo arenas show an invite prompt, not a board.** A leaderboard of one
      is a mirror. Keyed on *active member count*, deliberately **not** on
      visible rows: an arena where everyone else is `hidden` also renders one
      row, and telling that member to "invite people" would leak that others
      exist — precisely what `hidden` promises it will not. Owner sees the
      invite code inline; everyone else is pointed at the owner.
- [x] **Arena feed** — `GET /v1/arenas/:slug/feed` (`#7`) plus a feed panel
      under the rating board. Names are resolved through each member's
      *current* visibility in that arena, never from `users.handle`: an
      anonymous member gets their pseudonym, a hidden member's entries are
      dropped whole. This matters because the leak would be **retroactive** —
      resolving handles directly would expose every past event of someone who
      has since gone anonymous. Verified: going anonymous un-names your own
      history; going hidden removes it.
- [x] **Longest Reign hall of fame** (`#5.1`) — `/halls/longest-reign` and
      `GET /v1/halls/longest-reign`. Permanent, across every arena and season,
      with open reigns measured to now so the sitting Sovereign is still
      climbing it. An anonymous holder is pseudonymised rather than dropped —
      the reign is the achievement being honoured, the name is optional.
- [x] **Recompute moved into pg-boss** (`#8`): `npm run worker`, plus a
      `worker` service in compose. Recompute every 10 minutes, housekeeping
      (close elapsed seasons, prune sessions and enrollment codes) daily at
      03:17 UTC, and both fire once on start so a fresh deploy is not stale for
      a whole interval. `runRecompute` is shared by the job and the script, so
      a manual run cannot diverge from a scheduled one. Graceful SIGTERM, since
      a recompute killed mid-write would leave standings and reigns
      disagreeing.
- [x] Reign duration on the board — `#5.1` tracks `reign_length_days` because
      that *is* the tension. Shown in the season bar ("aafuwape has held the
      Throne 1h") and inline on the Sovereign row.
- [x] Hero stat strip, avatars, and top-3 emphasis (see the design note below)

### Board titles

`#5.1` supplies *Throne*, *reign*, *dethroned*. Positions are now named:

| Rank | Title | Note |
|---|---|---|
| 1 | **Sovereign** | holds the Throne |
| 2 | **Usurper** | next in line, waiting to take it |
| 3–4 | **Contender** | `#5.2`'s final four contest the reign |

Titles are withheld below 3 active members — "Sovereign" of two people is just
"the other one".

**On "Usurper" for #2.** Strictly, a usurper has already seized the throne and
a *pretender* merely holds a claim, so "Pretender" is the more precise word for
a runner-up. Rejected anyway, for two reasons that beat precision on a
leaderboard: "Pretender" reads as *faker* to a modern ear, which is a poor label
for someone performing well; and "Usurper" carries the threat, which is the
product — *"the Usurper is 40 points behind"* is the sentence that makes a
Sovereign log in. The overlap with the `usurped` event is a feature: the Usurper
is the one who is going to usurp.

**"Successor" stays rejected** for #1 — a successor is whoever comes *after*. It
does have a precise home: the person who ended a reign is that reign's
successor, i.e. `reigns.ended_by_user_id`. History, not the live board.

Feed events are `crowned` (first sovereign) and `usurped` (a takeover), in the
active voice with actor and target so each side renders its own sentence.

### Ship gate (`#4.4`) — ✅ PASSED

- [x] Simulation harness (`packages/scoring`): 500 synthetic players across all
      five archetypes, 3 seasons × 28 days, deterministic by seed
- [x] **Pass condition met on 8 of 8 seeds** with a +6.1pp worst-case margin.
      31 of 215 weightings in the grid pass every seed, so the result is robust
      rather than a single lucky point
- [x] Weight search (`npm run simulate -- --tune`), ranked by **worst-case
      margin**. Ranking by placement alone recommended a weighting that then
      breached the gate on 2 of 8 seeds — passing the seeds you searched is
      necessary but not sufficient
- [x] The gate is a test (`gate.test.ts`) and a CI-able exit code, so a
      regression here surfaces as a go/no-go change rather than a silent drift
- [x] The gate also asserts the **positive** claim (`efficient_daily` wins).
      `#4.4` states only three prohibitions, which a random ranking would
      satisfy

Result with the adopted weights (8 seeds, 500 players, 3 seasons):

```
archetype          mean pts  median %ile   best   top10  top25   eff tokens
whale_burner          636.5        30.0%  19.8%       0     25  1,807,688,206
efficient_daily       938.7         9.9%   0.0%      50    100     42,395,528
sporadic_genius       199.9        70.0%  60.1%       0      0     20,159,764
streak_farmer          98.7        89.9%  78.2%       0      0         89,718
cache_gamer           486.3        50.0%  36.3%       0      0      5,527,313
```

`whale_burner` carries **43x** the volume of `efficient_daily` and still cannot
reach the top 10%. That is `#4.4`'s premise, measured.

---

## M3 — Battle royale

- [x] Seasons: contiguous 4-week windows, rollover and close handled by the
      pg-boss `maintenance` job
- [x] **Shrinking circles (`#5.2`)** — cuts at day 7 / 14 / 21, bottom 25% then
      bottom 25% then down to the final four. Eliminated members stay listed,
      keep accruing, and are greyed as "out" with an `out` badge.
      - Titles go by position among members **still in contention**, not by
        overall rank, and the Throne can never go to an eliminated member even
        if their points are highest.
      - `status` is owned by `applyCircles` alone; the standings upsert
        deliberately omits it, or every recompute would un-eliminate the field.
      - The schedule is fixed **once** at season start from the member count
        then. Recomputing it live would let a joiner switch elimination on for
        people who never signed up to it, and a leaver switch it off again.
      - **Bug the tests caught:** folding due cuts from the *current*
        contention count made the function non-idempotent — after cut 1 took 12
        to 9, a re-run at the same boundary computed `survivors(cut1, 9) = 6`
        and ate three more. Running every ten minutes, that empties an arena
        over an afternoon. Now folded from `memberCountAtStart`, so the target
        is a pure function of the schedule and the clock.
- [x] **Duels (`#5.3`)** — propose / accept / decline / settle, wagering rating
      points, capped at 2 concurrent per user (`#5`), on `points`, `commits`
      or `edits`.
      - **Wagers live in `standings.duel_pts`, not `points`.** `points` is
        *derived* — the recompute replays it from `daily_scores` every ten
        minutes — so a wager written there would be silently erased. One
        column owned by the scheduler, one by settlement, `points` the sum.
      - The clock starts on **acceptance**, not proposal, so a slow reply does
        not eat the contested window.
      - The cap applies to **both** sides; enforcing it only on the challenger
        would let someone paralyse a rival by filling their slots.
      - A draw returns both stakes rather than splitting the pot — splitting
        would mean a drawn duel still moved the board.
      - Settlement is guarded on the state it read, so two concurrent passes
        cannot pay out the same pot twice.
      - No token metric, deliberately: `#4.1` says ranking on volume rewards
        waste, and a duel on tokens burned is a race to waste the most.
- [x] Notifications: webhook + Slack real, email stubbed
      (`packages/db/src/notifications.ts`)
      - Dispatched from the `events` log, never from a second queue — `#6` makes
        that log the single source behind "the feed, notifications, and the
        audit trail".
      - Recipients are the event's **actor and target only**. `#5.1` promises
        "a notification to both parties"; broadcasting a usurping to fifty club
        members *is* the board that pings all day.
      - Payloads are built **per recipient**, resolved through the same
        `arenaVisibility()` the feed uses, so a notification cannot be the one
        surface that names someone competing anonymously (`#2`). A recipient
        always sees their own handle — anonymity is about the board, not your
        own inbox.
      - Idempotent by a unique index on `(event_id, channel_id)`, which is what
        lets the dispatcher ride the 10-minute recompute over an overlapping
        window without ever sending twice.
      - Webhook bodies are HMAC-signed over `"{timestamp}.{body}"`, so a
        captured body cannot be replayed indefinitely — `#3.3`'s `seq`
        reasoning, applied outbound.
      - Targets are SSRF-screened: link-local (`169.254.169.254`) and
        `.internal` are refused in **every** environment, loopback and RFC 1918
        in production only, and redirects are never followed.
      - Email fails **loudly** rather than pretending: a silent fake success
        would let someone configure it and never be told anything.
- [x] **Rate-limit the drama (`#5`):** ≤1 throne notification per arena per
      hour. A board that pings all day gets muted, and a muted board is dead.
      - Measured against *deliveries*, not events, so the feed still shows
        every usurping and only the interruption is throttled.
      - Suppressed deliveries are **recorded** (`status = 'suppressed'`,
        `attempts = 0`), so the ledger explains the silence and a retry cannot
        resurrect it.
      - A *failed* send does not consume the hour — nothing was delivered, so
        the next usurping still gets its chance.
      - Per arena, not per user: two arenas cannot mute each other.
- [x] **Share cards** — each arena has a dynamic Open Graph card (and a
      “Share the Throne” control) rendering the current title, reign duration,
      top three and latest feed sentence. It deliberately consumes the same
      visibility-filtered board/feed APIs as the page: an anonymous competitor
      stays pseudonymous, and a hidden member cannot leak through an unfurl.
- [ ] Shields & bounties (`#5.4`) — v2, explicitly after the above

---

## M4 — Org

- [ ] Email-domain verification (`email_domain` is already populated at sign-in)
- [ ] Admin consent model + **aggregate-only** admin views
      (`GET /v1/orgs/:id/aggregate`) — `#2`'s hard invariant, and the only part
      of this with revenue in it
- [ ] Admin-API cross-verification → `org_verified` tier + gold badge.
      **`#3.4` says confirm the endpoint and per-key attribution before
      promising this** — treat as unvalidated until then
- [x] **VS Code Copilot reader** (`packages/readers/src/vscode-copilot.ts`) —
      pulled forward out of M4 because it turned out to be 46% of measured
      spend, not a long-tail nice-to-have.
      - Reading one agent out of two does not measure "AI coding-agent usage",
        it measures Claude Code usage, and every Copilot-heavy competitor reads
        as idle.
      - The file is a **journal**, not a log: `{kind:0}` snapshot, `{kind:1}`
        set-at-path, `{kind:2}` append-at-path. A line revises a request rather
        than adding one, so it must be replayed in order. The mirror image of
        Claude Code's trap, where lines *repeat* usage.
      - Covers Code, Insiders, VSCodium, Cursor and Windsurf on macOS, Linux
        and Windows — they share the `workspaceStorage` layout.
      - Uses `completionTokens`, not `result.metadata.outputTokens`: measured
        over 106 real requests the former is a median 1.85× the latter, the
        difference being reasoning tokens, which the response pane does not
        render and the vendor does bill. AgentsView uses the metadata figure,
        so our Copilot output reads ~2.4× theirs on the same window; neither is
        a transcription error.
      - Reports **zero** cache tokens, because Copilot exposes none. That is
        the value that leaves a Copilot user un-penalised: `signals.ts` maps a
        zero cache total to `null` and `zScores` scores a null at the cohort
        mean. An invented split would break that.
      - Gives a signal Claude Code cannot: VS Code records an explicit `Undo`
        event, which is the real `edits_reverted` `#4.2` wanted rather than the
        documented approximation.
      - Cost for this agent is **notional**. Copilot bills subscription premium
        requests (`copilotCredits`), not tokens; `cost_micros` is list-rate
        equivalence, the only basis on which two agents compare. `#4.2` scores
        on tokens, so no ranking depends on it.
- [ ] Codex reader (`~/.codex/sessions/`) — `#3.1` lists it for v1. `~/.codex`
      is present but empty on the reference machine, so the format is
      unverified; do not write it from memory.
- [ ] Remaining agents via AgentsView's readers (40+, incl. `.pb` and Aider's
      per-repo Markdown)
- [ ] Background service (`usurp service install`) for agents with no hook surface
- [ ] `unverified` tier: manual JSON upload — shown, flagged, excluded from title
      contention

---

## Cross-cutting

Not in any milestone, but shipping without them is how this breaks.

**Correctness / data**
- [ ] Pricing table refresh process — `models.ts` is a mirror cached
      2026-06-24; treat the `unknown_model` flag count as the staleness signal
- [ ] Partner-platform pricing (Bedrock/Vertex) currently approximated at
      first-party rates
- [ ] `edits_reverted` is an approximation (declined/failed edits, not a later
      `git checkout`) — either improve or document on the board itself
- [ ] Backfill/repair job for buckets whose model was unknown at ingest

**Ops**
- [ ] pg-boss wiring (`#8`): season rollover, daily decay, circle shrink, duel
      settlement, session + enrollment pruning
- [ ] `LISTEN/NOTIFY` → SSE for `GET /v1/arenas/:slug/stream` (`#7`)
- [ ] Rate limiting on `/v1/ingest` and `/v1/devices`
- [ ] Structured logging + an error reporter; ingest currently `console.error`s
- [ ] CI: typecheck, tests, `docker compose up` smoke test
- [ ] Burn board materialized view when the windowed aggregate gets slow

**Security**
- [ ] Security review of the auth surface once M1's HTTP layer lands
- [ ] Device revocation UI + a story for a leaked device key
- [ ] Account deletion purging `usage_events` (`#10.2` is a published promise
      with no implementation)
- [ ] Drop `drizzle-kit`'s dev-only esbuild advisory by moving migration
      generation into a container, or accept and document it

**Product / UX**
- [ ] Charts on `/u/<handle>` — per-day bars; deliberately deferred, it's a
      design task not a tack-on
- [ ] Accessibility pass (the board is a data table; keyboard + SR review)
- [ ] Empty and first-run states beyond the current board placeholder
- [ ] Publish the `#10` privacy commitments as a page, not just a README section

---

## Kill criteria

From `#1`, kept verbatim because it is the point of the whole build order:

> If after M2 the rating model can't beat naive burn in simulation (`#4.4`),
> **kill it** — without that, Usurp is a reskin of ccclub.

Concretely: if no weighting satisfies the `#4.4` pass condition, stop. Do not
ship M3 on top of a rating nobody can defend.

Secondary check from `#12`: eight-plus competitors are live. The four-way
combination in `#1` — three scopes, unfarmable rating, real elimination,
anti-cheat + org privacy — is the whole wedge. Losing any one of them collapses
the differentiation.

---

## Risks → where they're handled

| Risk (`#11`) | Mitigation | State |
|---|---|---|
| Crowded market, no wedge | Four-way combination; kill if M2's gate fails | tracked above |
| Rewards token waste | Two-board split, log volume, efficiency multiplier | Burn board shipped and labelled; rating is M2 |
| Forged submissions | Signing, trust tiers, plausibility gates, shadow-freeze | ✅ signing + gates shipped; shadow-freeze column exists, **no caller yet** |
| Org privacy backlash | Opt-in + aggregate-only admin views | ✅ default-hidden enforced in code; admin views are M4 |
| Notification fatigue | `#5` rate limits | ✅ enforced centrally in `notifications.ts`, tested |
| Anthropic ships this natively | Multi-agent + clubs + self-host | self-host ✅; clubs ✅; multi-agent ✅ 2 of 2 agents on the reference machine |

---

## Fixed: usage was double-counted across device re-enrolments

Found by comparing our numbers against AgentsView on the same machine. Our
board showed **832 calls** where the transcripts held **425**.

Not a reader bug. `dedupe_key` is `sha256(device_id|hour|agent|model)` —
deliberately per-device, so two real machines working in the same hour both
count. But re-enrolling *one* machine mints a new device identity, and
`usurp sync --all` then re-reads the same transcripts and books a second row
for every hour that device had already reported. Three enrolments of one laptop
produced roughly 2x the real usage.

The payload cannot distinguish the two cases: it is aggregate by design
(`#10.1` — no session ids), so the server has no per-call identity to match on.
What it *can* use is the enrolment boundary — a genuinely new machine has no
work predating its own enrolment. Ingest now refuses a bucket that both
predates the submitting device's `created_at` **and** is already covered by
another of that user's devices, with `duplicate_backfill` in `rejected[]`.

Rejected rather than flagged: a flagged row is still stored and still doubles
the board, which is the harm.

**Known false positive:** a second real machine used *before* usurp was
installed on it, in hours the first machine also worked. Its backfill for those
hours is refused. Rare, visible in `rejected[]`, and much better than silently
doubling someone's totals.

Also fixed while investigating: the reader counted `<synthetic>` model
messages. Claude Code writes those for locally-generated content (interrupt
notices, error placeholders) and they carry a `message.id` and a `usage` block
like any real call. Counted, they appear as an `unknown_model` bucket, get
flagged by `#3.4`, and pollute the per-model breakdown with a model nobody ran.

---

## Operational: renaming a model string strands rows rather than merging them

Found while shipping the Copilot reader. `dedupe_key` is
`sha256(device_id|hour|agent|model)`, so **the model string is part of the
identity of a row**. Normalizing `gpt-5.5-2026-04-23` down to `gpt-5.5` in the
reader therefore did not update 39 existing rows — it minted new keys and left
the old rows in place, double-counting 58 calls under two aliases of the same
model.

The `GREATEST()` upsert cannot help here: it merges rows that *share* a key, and
this changed the key. Nothing was wrong with ingest; the lesson is that a
reader-side identifier change is a **data migration**, not a code change.

**Rule going forward:** any change to `bucket.agent` or `bucket.model` needs a
companion cleanup that deletes or re-keys the affected `usage_events`, followed
by a recompute. Normalize aggressively in the reader *before* first sync, not
after.

---

## Verified: reconciliation against AgentsView, both agents

Same machine, all-time, after the Copilot reader landed. Usurp reads 1,314 calls
across 2 agents and 10 models, **zero `unknown_model` flags**.

| | Usurp | AgentsView | Note |
|---|---|---|---|
| Copilot input tokens (30d) | 25,044,666 | 25,070,889 | −0.10%, window-boundary only |
| Copilot output tokens (30d) | 526,552 | 222,982 | **Deliberate divergence** — reasoning tokens, see M4 |
| Claude Code input / output | 896 / 647,703 | identical | exact |
| Claude Code cache reads | 211,242,526 | identical | exact |

The output-token gap is the one figure that is not agreement, and it is a
choice rather than a defect: Copilot records both `completionTokens` (the
model's usage report, includes reasoning) and `result.metadata.outputTokens`
(the rendered response). A burn league bills what the model billed.

What Usurp still does **not** have that AgentsView does: per-project breakdown.
That is deliberate — `#10.1` promises no file paths and no project names leave
the machine, and `bucket.ts` drops `cwd` at the privacy boundary. Per-model and
per-agent are both present.

## Design: what to take from Viberank, and what not to

`#12` lists Viberank as prior art. Checked against the live site, it is
**list-based**, not card-based — the difference from our board was never layout.
What it actually has that we lacked, and what happened to each:

| Viberank | Taken? |
|---|---|
| Hero stat strip | ✅ adapted — see below |
| Avatars | ✅ added (we had stored `avatar_url` since M1 and never rendered it) |
| Top-3 emphasis | ✅ on the **rating** board only |
| Metric tabs | ✅ already had them (Rating / Burn) |
| Join CTA | ✅ already in the empty states |
| **Tier badges by spend** ($0+ … $50K+) | ❌ **declined — see below** |

**The hero leads on the Sovereign, not on spend.** Viberank's headline is
dollars burned; `#4.1` says ranking on spend "rewards waste", so leading on it
would make the front page an advertisement for the behaviour this product
exists to stop. Cost is present, last, and labelled an estimate. The lead
figure is who holds the Throne and for how long.

**Spend tiers are declined outright.** Viberank has six tiers keyed to dollars
spent; `#1` names "another token leaderboard… which rewards waste" as the thing
not to build, and `#4.1` reserves titles for rating. We already have the
earned version of that idea — Sovereign / Usurper / Contender, won by rating,
not bought. Adding spend tiers would reintroduce exactly the mechanic `#1` says
is the biggest opening in the market.

**Top-3 emphasis is rating-only.** Enlarging the top spender on the Burn board
would dress volume up as achievement, which is the reskin failure mode `#1`
warns about. Burn keeps uniform avatars and no rank hierarchy.

---

## Resolved during M2: which cohort do z-scores use?

`#4.2` (line 121) says signals are normalized against "the user's own **arena
cohort**". `#6` (line 36) says scores are "computed once, **globally**, per user
per day... never per-arena scoring logic". Both cannot hold — under `#4.2` a
user in three arenas has three daily scores, and `daily_scores` is keyed
`(user_id, day)`.

**Resolved in favour of `#6`.** `#4.2`'s stated rationale ("so a hobbyist isn't
scored against a monorepo team") is not achieved by cohort-relative efficiency:
the hobbyist/team gap lives in `volume_pts`, which is absolute. Measured, a
hobbyist day scores 25.2 volume points against a heavy day's 45.1, and that
19.9-point gap is identical whichever cohort you normalize against.

**But this is not a free choice, and the roadmap should not pretend it is.**
Simulated on a homogeneous 12-person club inside a 500-player field, global and
arena-local z agreed on only **44.6%** of within-club orderings (random ≈ 8%).
So the two produce genuinely different boards, and `#6`'s consistency costs
discrimination inside small cohorts. If that matters in practice the fix is a
per-arena rating table, not a tweak.

**Action:** ✅ folded into `SPEC.md#4.2` (2026-09-09). The arena-cohort clause
is gone, so the spec no longer asks for something it also forbids, and the
44.6% figure is recorded there along with the note that revisiting the decision
means a schema change rather than a tuning change.

---

## Next action

M2 and M3 are closed. Next, in order:

1. **M3 is complete.** Share cards (`#9`) now render from the same
   visibility-safe board/feed data as the page.
2. ✅ **Done** — the deviations and the resolved contradiction are folded into
   `SPEC.md` (2026-09-09). Ten `Amended`/`Resolved` notes across `#3.1`, `#3.3`,
   `#3.4`, `#4.2`, `#5` and `#6.1`, each keeping the original claim and the
   measurement that overturned it. An amendment index sits at the top.
3. **Codex reader** — `#3.1` lists it for v1 and it is still missing.
   `~/.codex` exists but is empty on the reference machine, so the format must
   be verified against real data first, not written from memory.
4. **Account deletion that purges `usage_events`** — `#10.2` is a published
   promise with no implementation.
5. Rate-limit `/auth/*` and `/v1/me/enrollments`.

Keep `npm run simulate` in CI. It is the only thing standing between a future
weight or signal change and silently shipping a farmable rating.
