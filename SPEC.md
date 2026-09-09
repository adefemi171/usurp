# Usurp — Product & Technical Spec

**One-liner:** A competitive league for AI coding-agent usage. Hold the Throne in a global arena, your organization, or a private club of friends — and lose it the moment someone plays better than you.

Status: **amended against the implementation.** Original draft 2026-09-08,
pre-implementation. Amendments 2026-09-09, marked inline.

Five rules in the original draft did not survive contact with real data. They
are corrected in place below, each with an **Amended** note recording what the
draft said, why it was wrong, and the measurement that settled it — because a
spec whose corrections are invisible is a spec nobody can trust twice.

| § | Original | Now | Cause |
|---|---|---|---|
| `#3.3` | signature covers `buckets` | covers the whole envelope | a captured payload was replayable verbatim |
| `#3.4` | `cache_read ≤ k × input_tokens` | context-window ceiling per call | the gate rejected **all** real traffic (measured 8,428:1) |
| `#3.4` | "`dedupe_key` is `UNIQUE` so replays are no-ops" | `GREATEST()` max-merge | a re-read of a partly observed hour legitimately revises it upward |
| `#4.2` | `efficiency_mult = clamp(0.5, 2.0, Σwᵢzᵢ)` | `clamp(0.5, 2.0, 1 + Σwᵢzᵢ)` | the median player got the 0.5 floor |
| `#4.2` | `cache_ratio`, unbounded `yield` | `cache_reuse` penalty-only, volume-floored `yield` | both signals ranked the gamer above the honest user |

One contradiction *between* sections was also resolved: `#4.2` asks for
arena-cohort z-scores while `#6` requires a single global computation. Resolved
in favour of `#6`, with the measured cost recorded under `#4.2`.

Four further notes record things the draft left implicit that turned out to
be load-bearing — `#3.1` (v1's reader set, and that per-agent telemetry is not
uniform), `#3.3` (`dedupe_key` includes the model string, so renaming a model
is a data migration), `#5` (a cut must be idempotent), `#6.1` (the recompute
cannot run inside the ingest request). Ten notes in total; every one of them
was a bug before it was a rule.

Nothing below is aspirational. Where the spec still describes unbuilt work it
says so: `#3.1` Codex, `#3.4` `org_verified` and shadow-freeze, `#5.4` shields
and bounties, `#9` M4.

---

## 1. Go / no-go verdict

The market is crowded (8+ live products; see `#12 Competitive landscape`). Building "another token leaderboard" is a bad idea. Building Usurp is defensible only if it holds all four of these at once — no incumbent holds more than two:

1. **Three scopes in one account** — global, verified organization, private club. ccclub has clubs but no accounts; Fancysauce has teams but no global; CCgather has global + badges but no groups.
2. **Rating that can't be farmed by burning tokens.** Every incumbent ranks by raw spend, which rewards waste. This is the single biggest opening (see `#4`).
3. **A real elimination mechanic**, not just a sorted list. Every leaderboard already "displaces the previous #1" — that is not a feature. Seasons, shrinking circles, at-risk rating and duels are.
4. **Anti-cheat + org-grade privacy.** The moment rank has stakes, payloads get forged. And org arenas are the only part of this with revenue in it, which means the surveillance problem must be solved, not shipped.

**Recommendation:** build it, but treat #2 and #4 as the product and #1/#3 as the hook. If after M2 the rating model can't beat naive burn in simulation (`#4.4`), kill it — without that, Usurp is a reskin of ccclub.

---

## 2. Scope model

One entity: the **Arena**.

| Type | Membership | Size | Verification | Default visibility |
|---|---|---|---|---|
| `global` | Auto-enrolled on opt-in | unbounded | signed CLI | `public` |
| `org` | Email domain or Admin-API verified | unbounded | org-verified | **`hidden`** (opt-in per member) |
| `club` | Invite code / link | ≤ 50 | signed CLI | `public` within club |

Rules:
- A user is in at most one `org`, zero-or-one `global`, and many `club`s.
- Per-arena visibility: `public` | `anonymous` | `hidden`. `anonymous` shows a stable pseudonym ("Anonymous Falcon") at the user's true rank — they still compete, they just aren't named.
- **Org arenas are opt-in per member, and admins see aggregates only unless a member sets `public` in that arena.** This is a hard product invariant, not a setting. It is what separates Usurp from an internal surveillance board.
- Scores are computed once, globally, per user per day. Arenas are views over the same `daily_scores` — never per-arena scoring logic. This keeps a user's rating consistent everywhere and makes arena joins/leaves cheap.

---

## 3. Ingestion

### 3.1 Sources
Reuse [AgentsView](https://github.com/kenn-io/agentsview)'s session readers — **MIT licensed** (verified), so vendoring with attribution is fine. It already covers 40+ agents and the awkward formats (`.pb`, Aider's per-repo Markdown).

- v1: Claude Code (`~/.claude/projects/*.jsonl`), **VS Code Copilot** (`…/User/workspaceStorage/*/chatSessions/*.jsonl`)
- v1, still missing: Codex (`~/.codex/sessions/`)
- v2: whatever AgentsView's readers give us for free

Fallback if vendoring proves messy: `ccusage`-style parsing for Claude Code only (the path Viberank took). Ship v1 either way; keep the reader behind a `UsageReader` interface so the choice is reversible.

> **Amended 2026-09-09 — v1 gained Copilot before Codex, and the second reader
> was not optional.**
>
> The draft treated everything after Claude Code and Codex as v2 "for free".
> Measured on the reference machine, Claude Code was $148.84 of notional model
> spend and VS Code Copilot was **$128.96 — 46% of the total, on models Usurp
> could not see at all.** A league reading one agent is not measuring
> "AI coding-agent usage", it is measuring Claude Code usage, and every
> Copilot-heavy competitor reads as idle. So Copilot was pulled forward out of
> M4 and Codex slipped: `~/.codex` exists but is empty here, and its format
> must be verified against real data rather than written from memory.
>
> Two format traps, worth recording because they are opposites:
>
> - **Claude Code repeats.** It writes one line per *content block* and copies
>   `message.usage` verbatim onto every one. Summing lines overstated usage by
>   ~2.28× on real data. Key on `message.id`, the API's own billing unit.
> - **Copilot revises.** Its `.jsonl` is not a log but an incremental
>   **journal** against one object — `{kind:0}` snapshot, `{kind:1}`
>   set-at-path, `{kind:2}` append-at-path — so a line is meaningless alone and
>   the file must be replayed in order. Summing lines would count a request
>   once per revision.
>
> Neither trap is visible without checking totals against an independent tool,
> which is the argument for doing that before trusting any new reader.

Per-agent telemetry is **not uniform**, and the scoring path has to tolerate that rather than assume it:

| | Claude Code | VS Code Copilot |
|---|---|---|
| Cache read / write | reported, with 5m/1h TTL split | **not exposed at all** |
| Output tokens | `usage.output_tokens` | `completionTokens` (includes reasoning) vs `metadata.outputTokens` (rendered only) — median 1.85× apart |
| Reverted edits | inferred from denials; cannot see a later `git checkout` | explicit `Undo` event — the *real* signal `#4.2` wanted |
| Billing | per token | subscription premium requests (`copilotCredits`) |

Consequences, all deliberate:
- Zero cache tokens must mean "not reported", not "zero reuse" — see `#4.2`'s missing-signal rule. Inventing a cache split to fill the gap would penalise a user for their vendor's telemetry.
- `cost_micros` for an agent that does not bill per token is **list-rate equivalence**, not an invoice. It is the only basis on which two agents compare. `#4.2` scores on tokens, so no ranking depends on it — but `#4.1`'s Burn board now mixes a real bill with an equivalence and should say so.
- Where an agent reports output two ways, take the model's own usage figure. A burn league bills what the model billed, reasoning tokens included.

### 3.2 Trigger
- **Claude Code plugin** with a `SessionEnd` hook → `usurp sync` (the Fancysauce approach; zero-friction, no daemon).
- **Background service** (`usurp service install`) for agents with no hook surface.
- Manual `usurp sync` always available.

### 3.3 Payload — the privacy contract
Published verbatim in the README. Aggregated **client-side into hourly buckets** before it leaves the machine:

```json
{
  "v": 1,
  "device_id": "dev_…",
  "seq": 42,
  "submitted_at": "2026-09-08T14:02:11Z",
  "buckets": [{
    "hour": "2026-09-08T13:00:00Z",
    "agent": "claude-code",
    "model": "claude-opus-5",
    "input_tokens": 12043,
    "output_tokens": 3311,
    "cache_write_tokens": 8100,
    "cache_read_tokens": 96500,
    "calls": 14,
    "sessions_started": 2,
    "sessions_completed": 1,
    "sessions_abandoned": 1,
    "edits_applied": 9,
    "edits_reverted": 1,
    "commits": 2,
    "cost_micros": 41200,
    "dedupe_key": "sha256(device_id|hour|agent|model)"
  }],
  "sig": "ed25519(device_privkey, canonical_json({v, device_id, seq, submitted_at, buckets}))"
}
```

> **Amended 2026-09-09 — the signature covers the envelope, not just the buckets.**
>
> The draft specified `sig = ed25519(device_privkey, canonical_json(buckets))`.
> That signs *what* was submitted but not *who* submitted it, *when*, or *in
> what order* — so a payload captured off the wire is replayable verbatim
> against the same device forever, and the signature validates every time. The
> `seq` and `submitted_at` fields exist precisely to be inside the signed
> material; leaving them outside it makes them attacker-editable and therefore
> worthless.
>
> `v` is inside too, so a future envelope version cannot be downgraded to v1 by
> stripping a field.
>
> `canonical_json` is the RFC 8785 subset: keys sorted recursively, integers
> only. Floats are **rejected** rather than serialized, so no rounding
> difference can ever change the bytes being signed. This is why `cost_micros`
> is an integer and not a float dollar amount.

**Never transmitted:** prompts, completions, code, file paths, repo names, branch names, cwd, session IDs, tool arguments. `commits` is a *count* obtained from `git rev-list --count --author=<local user> --since=<hour>` in the session's cwd — no repo identity, no messages.

Hourly buckets (not per-message) keep the DB small, make dedupe trivial, and mean a leak of the events table reveals nothing about anyone's work.

> **Amended 2026-09-09 — `dedupe_key` includes the model string, which makes it
> a schema.**
>
> Not a correction to the definition, a consequence of it that cost real data.
> Because `model` is part of the key, changing how a reader spells a model
> renames the row's identity: normalizing `gpt-5.5-2026-04-23` down to
> `gpt-5.5` did not update 39 existing rows, it minted new keys and stranded
> the old ones, double-counting 58 calls under two aliases of one model. The
> `GREATEST()` merge below cannot help, because it merges rows that *share* a
> key and this changed the key.
>
> **Rule:** any change to `bucket.agent` or `bucket.model` is a data migration,
> not a code change. Normalize aggressively in the reader before first sync.

### 3.4 Anti-cheat
Trust tiers, shown as a badge and filterable on every board:

| Tier | How | Boards |
|---|---|---|
| `unverified` | manual JSON upload | shown, flagged, excluded from title contention |
| `cli_signed` | ed25519 device key registered at login, every delta signed | all |
| `org_verified` | cross-checked against the org's authoritative usage/cost reporting via Anthropic's Admin API (**confirm endpoint + per-key attribution before promising this**) | all, gold badge |

Server-side plausibility gates on every submit:
- Per-model tokens/hour ceiling — reject physically impossible throughput.
- **Per-call context ceiling:** `(input + cache_read + cache_write) / calls ≤ context_window(model)`. Cache reads are the cheapest metric to forge and the most valuable to the efficiency multiplier, so they must be bounded — but by the model's real physical limit, not by `input_tokens`.
- Monotonic per-device `seq`; on a stale `seq` the server returns its own `last_seq` so a client whose local counter was lost can re-anchor. Possession of the key is still required to use it, so disclosing the counter costs nothing.
- `dedupe_key` is `UNIQUE`, and a conflict **max-merges** each counter rather than being ignored.
- **Duplicate-backfill guard:** a bucket that both predates its device's own `created_at` *and* is already reported by another of the user's devices is rejected.
- **Historical import:** normal ingestion rejects buckets older than 90 days.
  `sync --all` marks older buckets with optional, signed `historical: true`,
  bypassing only that age limit. Original dates, models, and agents remain in
  profile analytics (select All time), but historical buckets are excluded from
  rating inputs, streak lookback, and duel metrics. The flag is sticky on upsert;
  re-submission cannot promote archived activity into competition. Existing
  signatures, sequence checks, plausibility gates, and deduplication still apply.
  Imports use bounded batches and leave the incremental sync cursor unchanged.
- Anomaly flag → shadow-freeze the user's rank pending review rather than hard-rejecting (false positives on a heavy user are worse than a slow cheat).

> **Not built as of 2026-09-09**, stated plainly so this table is not read as a
> description of what runs:
>
> - **`org_verified`** exists as an enum value and nothing assigns it. The
>   draft's own parenthesis — *confirm endpoint + per-key attribution before
>   promising this* — is still unresolved, so the gold badge is unearnable and
>   must not be advertised.
> - **Shadow-freeze** is half-wired: `review_state = 'shadow_frozen'` is
>   *read* by the board and the profile, which render the flag correctly, but
>   **no code path writes it.** The gates flag individual buckets; nothing
>   promotes a pattern of flags into a freeze. Until something does, the
>   anti-cheat story ends at per-bucket rejection.
> - **`unverified`** (manual JSON upload) has no upload endpoint.

Gate order is load-bearing: resolve device → **verify signature** → check `seq` → run content gates → merge. Gating an unsigned payload tells you nothing about who sent it, and a replayed payload passes every content gate by construction, because it was valid the first time.

> **Amended 2026-09-09 — the `cache_read ≤ k × input_tokens` gate rejected all
> real traffic.**
>
> The draft assumed `input_tokens` is the prompt size. It is not: it is only
> the *uncached remainder* of the prompt. On a well-cached session the cached
> part is enormous and the remainder is a handful of tokens, so the ratio is
> not "a sane multiple" but four orders of magnitude out. Measured on a real
> transcript: `input = 2`, `cache_read = 16,857` — a ratio of **8,428:1**.
>
> The gate was therefore inverted in the worst possible way: the ratio is
> *highest* for the best-behaved users, so the rule would have banned exactly
> the people the rating is designed to reward, while a wasteful user who never
> caches would sail through.
>
> Replaced with the context window, which is a real physical ceiling: no single
> call can read more context than the model can accept. It bounds the forgeable
> quantity without punishing cache hygiene. Regression-tested against the
> observed values in `packages/protocol/src/gates.test.ts`.
>
> Unknown models get a deliberately generous default window and an
> `unknown_model` flag rather than a rejection — `#3.4`'s own principle is that
> a false positive on a heavy user is worse than a slow cheat, and a
> newly-released model is indistinguishable from a forged one by name alone.

> **Amended 2026-09-09 — "`dedupe_key` is `UNIQUE` so replays are no-ops" was
> too strong.**
>
> True for an actual replay, which carries identical values. But the same key
> is legitimately re-submitted with *higher* counters: a session still running
> when the first sync fired has since finished, so a re-read of that hour
> honestly reports more. `ON CONFLICT DO NOTHING` would silently discard that
> correction, and overwriting would be wrong in the other direction — a
> narrower lookback window produces a smaller honest count for the same hour,
> which must not erase what we already know.
>
> Counters only grow as more of an hour is observed, so `GREATEST(existing,
> incoming)` per column is the only operation that is both correct and
> idempotent. Replays remain no-ops, as promised; partial hours now repair
> themselves.
>
> A batch that claims a device and fails its signature is **not** stored with
> `sig_ok = false`. That column is for the `unverified` tier's manual uploads,
> which are *expected* to be unsigned. A failed signature on a claimed device is
> a forgery attempt, and storing it would let an attacker write to another
> user's counters simply by being wrong.

---

## 4. Scoring — the core of the product

### 4.1 Two boards, honestly labelled
- **Burn** — raw tokens and cost. Keep it. It is what draws people in. Label it as *volume, not skill*, and make it explicitly non-competitive: no season, no elimination, no title.
- **Rating** — the actual league. Titles, seasons, and elimination attach only to this.

### 4.2 Daily score

```
points(day) = volume_pts × efficiency_mult × streak_mult

volume_pts      = 10 × log10(1 + effective_tokens / 1000)
effective_tokens= input + output + cache_write        (cache_read excluded — it's cheap)
efficiency_mult = clamp(0.5, 2.0, 1 + w1·cache_reuse_z + w2·yield_z + w3·completion_z)
streak_mult     = min(1.25, 1 + 0.03 × consecutive_active_days)
```

Signals feeding `efficiency_mult`, all normalized to a z-score against the day's active cohort:

| Signal | Definition | Why it resists farming |
|---|---|---|
| `cache_reuse` | `cache_read / (cache_read + cache_write)`, contributing `min(0, z)` — **penalty only** | High reuse earns nothing, so it cannot be farmed by idling; low reuse still punishes the re-cacher |
| `yield` | `merged_commits / max(effective_tokens, 100_000)` per MTok | Directly punishes burn-without-output; the floor stops it exploding as tokens → 0 |
| `completion` | `sessions_completed / sessions_started` | Punishes abandoned thrash loops |

**Weights adopted:** `cache_reuse = 0.05`, `yield = 0.2`, `completion = 0.1` — yield-led, because yield is the only signal a gamer cannot fake without doing the work. 31 of 215 grid weightings pass every seed of `#4.4`; these clear it with a +6.1pp margin.

A **missing** signal (no caching at all, no sessions) scores at the cohort mean, not worst-in-cohort. Otherwise an agent that simply does not report a metric — Copilot exposes no cache accounting at all — would be penalised for its vendor's telemetry rather than its user's behaviour.

> **Amended 2026-09-09 — `efficiency_mult` was missing its centre.**
>
> `clamp(0.5, 2.0, Σwᵢzᵢ)` over *zero-centered* z-scores hands the median
> player the 0.5 **floor**, and pins everyone at or below average there — so
> the multiplier cannot discriminate across the bottom half of the cohort at
> all:
>
> ```
> z = ( 0, 0, 0)  ->  0.500   median player, minimum multiplier
> z = (-1,-1,-1)  ->  0.500   indistinguishable from median
> z = (+1,+1,+1)  ->  1.000   above average, still only neutral
> ```
>
> Adding the `1 +` makes the median neutral at 1.0, which is what a multiplier
> named "efficiency" has to mean. Without it, half the league is scored
> identically and `#4.4`'s invariant cannot hold by construction.

> **Amended 2026-09-09 — both farmable signals were replaced. Settled by the
> `#4.4` harness, not by argument, and the answer was not the one proposed.**
>
> **a. `cache_ratio` as specified has no variance.** `cache_read / (input +
> cache_read)` pins to ~0.9999 for every competent user, because `input` is the
> uncached remainder (same root cause as the `#3.4` gate). A signal with no
> spread contributes nothing but noise.
>
> **b. The obvious replacement is still farmable — it ranks the gamer first.**
> `cache_read / (cache_read + cache_write)` isolates the whale correctly but is
> *inverted among honest users*. Measured over the simulated cohort:
> `cache_gamer` 0.9992 > `sporadic_genius` 0.9741 > `efficient_daily` 0.9626 >
> `whale_burner` 0.6301. A high ratio is achieved by **not writing cache** —
> which is what someone with nothing to do looks like. Hence penalty-only: you
> cannot earn rating by not working.
>
> **c. `yield` is unbounded as tokens → 0.** `streak_farmer` averaged **290.6**
> commits/MTok against `efficient_daily`'s 18.7, on ~1,074 tokens/day. Because
> z-scores are cohort-relative, that heavy tail compressed every real user's
> yield score toward zero. A 100k effective-token floor in the denominator
> leaves real users untouched and removes the tail.

> **Resolved 2026-09-09 — `#4.2` and `#6` contradicted each other on cohorts.**
>
> This section says z-scores are taken "against the user's own arena cohort (so
> a hobbyist isn't scored against a monorepo team)". `#6` says `daily_scores` is
> keyed on `(user_id, day)` and **not** season — "one computation, many arena
> views". Both cannot hold: a per-arena z-score makes `points` a function of
> arena, which needs one row per `(user, day, arena)`.
>
> **Resolved in favour of `#6`**, because the alternative multiplies the hottest
> write path by every arena a user belongs to, and `#6.1` already has to hold a
> per-arena lock. z-scores are computed against the day's global active cohort.
>
> The cost was measured rather than waved away, and it is not small: within-club
> ordering agrees with the per-arena ideal only **44.6%** of the time (150/336
> positions over 28 days, against a ~8.3% random baseline). An earlier claim
> that the choice "barely changes ordering" was wrong. Reproduce with
> `npm run cohort`.
>
> The fairness worry this section actually voices — "so a hobbyist isn't scored
> against a monorepo team" — turns out to live somewhere else: `volume_pts` is
> **absolute, not cohort-relative**, so the 19.9-point volume gap between a
> hobbyist and a whale is identical under either cohort. Only the efficiency
> multiplier moves. That narrows the concern considerably without dismissing it.
>
> If club-scoped fairness later matters more than write cost, this is the
> decision to revisit — a per-arena rating table, not a weight tweak.

### 4.3 Decay — the mechanic that makes it a battle royale
Seasonal points decay **5%/day of inactivity**. Standing still is falling. The reigning champion cannot bank a win and coast; the throne must be actively held. This, not the sorted list, is what produces the "previous top user gets pushed off" feel the product is named for.

### 4.4 Design invariant + how it gets validated
> **The optimal strategy to hold the Throne is consistency × efficiency, never volume.**

Because volume is log-scaled (10× the tokens = +10 points) while efficiency is a ×[0.5, 2.0] multiplier, an efficient daily player should beat a wasteful whale. **This must be proven, not asserted.** M2 ships a simulation harness: 500 synthetic players across archetypes — `whale_burner`, `efficient_daily`, `sporadic_genius`, `streak_farmer`, `cache_gamer` — run over 3 simulated seasons. Ship condition: `whale_burner` does not place top-10%, and `streak_farmer`/`cache_gamer` do not place top-25%. If weights can't be tuned to satisfy that, the premise is wrong (see `#1`).

---

## 5. The battle-royale layer

1. **Throne & Reign.** #1 in an arena holds the Throne; `reign_length_days` is tracked. A change of #1 closes the old reign, opens a new one, and emits a `dethroned` event → notification to both parties + the arena feed. **Longest Reign is its own permanent hall-of-fame board**, so being dethroned still leaves a record — this softens churn at the top and gives a second axis to compete on.
2. **Shrinking circles.** In arenas with ≥8 active members, a 4-week season runs in circles: wk1 everyone → wk2 bottom 25% eliminated from *title contention* → wk3 bottom 25% again → wk4 final four contest the Reign. Eliminated members stay visible and keep accruing Burn stats, greyed as "out." Everything resets next season. Arenas <8 members run seasons without elimination.
3. **Duels.** Challenge a named member over a fixed window (24h / 7d) on a chosen metric, wagering rating points. Winner takes the pot. This is Fancysauce's "challenge a teammate" with actual stakes.
4. **Shields & bounties** (v2). Spend banked points on a 24h anti-dethrone shield, or place a bounty on the current Throne that pays out to whoever takes it.

**Rate-limit the drama:** at most one `dethroned` notification per arena per hour, and duels capped at 2 concurrent per user. A board that pings all day gets muted, and a muted board is a dead board.

> **Amended 2026-09-09 — three details this section leaves implicit, each of
> which was a bug before it was a rule.**
>
> **A cut must fold from the season's starting size, not the current field.**
> "bottom 25% eliminated" reads as a fraction of who is *still in contention* —
> but the recompute runs every 10 minutes, and re-deriving the cut from the
> shrinking field meant each pass ate more of the arena (12 → 9 → 6 → …) until
> almost nobody was left. The target is folded from
> `season.member_count_at_start`, which makes the operation idempotent. A
> non-idempotent elimination in a scheduled job is silently destructive.
>
> **The rate limit must be measured against deliveries, not events.** Counting
> events would make the *feed* lossy to protect the inbox; `#6` has one
> append-only log behind both. Suppressed deliveries are recorded explicitly
> (`status = 'suppressed'`, `attempts = 0`) so the ledger explains the silence,
> and a *failed* send does not consume the hour — nothing was delivered, so the
> next usurping still gets its chance.
>
> **"a chosen metric" cannot include tokens.** `#4.1` says ranking on volume
> rewards waste; a duel on tokens burned is a race to waste the most, inside
> the one part of the product with stakes attached. Duel metrics are `points`,
> `commits`, `edits` — no token metric, deliberately. Draws return both stakes
> rather than splitting the pot, because a split still moves the board.

---

## 6. Data model (Postgres)

```sql
users            (id, handle UNIQUE, display_name, avatar_url, email_domain,
                  default_visibility, created_at)
identities       (user_id, provider, provider_uid, PRIMARY KEY(provider, provider_uid))
devices          (id, user_id, public_key, label, trust_tier, last_seen_at)

usage_events     (id, user_id, device_id, agent, model, hour,
                  input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
                  calls, sessions_started, sessions_completed, sessions_abandoned,
                  edits_applied, edits_reverted, commits, cost_micros,
                  dedupe_key UNIQUE, sig_ok, submitted_at)

arenas           (id, type, name, slug UNIQUE, invite_code, owner_user_id,
                  max_members, settings JSONB, created_at)
arena_members    (arena_id, user_id, joined_at, visibility, status,
                  PRIMARY KEY(arena_id, user_id))

seasons          (id, arena_id, idx, starts_at, ends_at, circle_schedule JSONB, state)
daily_scores     (user_id, day, volume_pts, efficiency_mult, streak_mult, points,
                  PRIMARY KEY(user_id, day))
standings        (season_id, user_id, points, rank, prev_rank, status, updated_at,
                  PRIMARY KEY(season_id, user_id))

reigns           (id, arena_id, user_id, started_at, ended_at, ended_by_user_id, peak_points)
duels            (id, arena_id, challenger_id, opponent_id, metric, wager_pts,
                  window_start, window_end, state, winner_id)
events           (id, arena_id, type, actor_id, target_id, payload JSONB, created_at)
achievements     (code, name, description, tier, predicate JSONB)
user_achievements(user_id, code, earned_at, PRIMARY KEY(user_id, code))
```

Notes:
- `daily_scores` is keyed on user, **not** season — one computation, many arena views (`#2`). This is what forced the cohort decision recorded under `#4.2`: a per-arena z-score would need one row per `(user, day, arena)`.
- `standings` is a real table refreshed transactionally, not a view; the board is the hottest read path and must not recompute per request.
- `events` powers the feed, notifications, and the audit trail from one append-only log.

### 6.1 Recompute path
Upsert `usage_events` on ingest. Then, **on a schedule**: recompute `daily_scores` for affected days → recompute `standings` for every arena → diff rank 1 → close/open `reigns`, emit events → dispatch notifications.

Take a **per-arena Postgres advisory lock** around the standings write, and a **per-device** one around ingest. Two members syncing simultaneously will otherwise race and can produce two open reigns; two syncs from one device (a `SessionEnd` hook firing during a manual sync) will otherwise both read the same `last_seq` and both pass the monotonicity check.

> **Amended 2026-09-09 — the recompute cannot run inside the ingest request.**
>
> The draft says "on ingest", which holds for the `standings` half but not for
> `daily_scores`. z-scores are cohort-relative, so **one late bucket from one
> user shifts the cohort mean for that day and changes every other user's score
> for it.** A correct recompute is therefore inherently O(active users ×
> affected days) — it cannot sit inside the HTTP request a `SessionEnd` hook is
> blocking on, or the hook becomes something people uninstall (`#3.2`).
>
> Ingest stays fast; the recompute runs every 10 minutes via pg-boss, whose
> state lives in the same Postgres so `#8`'s single-`docker-compose.yml`
> self-host promise still holds. The decay replay is **path-dependent** and
> cannot be expressed as a `SUM()`, which is the other reason it is a job.

Two columns on `standings` have **single owners**, and a recompute must
preserve rather than recalculate them: `status` belongs to circle elimination
(`#5.2`) and `duel_pts` to duel settlement (`#5.3`). A replay that recomputed
either from daily scores would silently un-eliminate a cut player or void a
settled wager.

### 6.2 Late data (get this right early)
A laptop offline for three days will submit backdated buckets. Rule:
> **Points and standings are always recomputed from current data. `reigns` and `events` are append-only and are never rewritten.**

A dethrone that was announced stands, even if late data would have prevented it. The alternative — retroactively un-crowning someone — is both a correctness nightmare and a terrible experience. Document this in the FAQ before anyone asks.

---

## 7. API surface

```
POST /v1/ingest                 signed bucket batch → {accepted, rejected[], flags[]}
POST /v1/devices                register device pubkey
GET  /v1/me                     profile, arenas, rating, trust tier
PATCH/v1/me/arenas/:id          set visibility | leave
GET  /v1/arenas/:slug/board     ?window=day|week|season|all &metric=rating|burn  (paginated)
GET  /v1/arenas/:slug/feed      dethrones, duels, eliminations, achievements
GET  /v1/arenas/:slug/stream    SSE: live rank deltas
POST /v1/arenas                 create club → invite_code
POST /v1/arenas/join            {invite_code}
POST /v1/duels                  challenge
POST /v1/duels/:id/accept
GET  /v1/halls/longest-reign    permanent hall of fame
GET  /v1/orgs/:id/aggregate     admin: aggregates only, never per-member
```

---

## 8. Stack

| Layer | Choice | Rationale |
|---|---|---|
| CLI | TypeScript, `npx usurp` | Matches every incumbent's install story; same language as the plugin |
| Plugin | Claude Code plugin, `SessionEnd` hook | Zero-friction ingestion, no daemon |
| API | Next.js App Router (or Fastify if the CLI-only surface grows) | One deploy for board + API |
| DB | Postgres (Neon/Supabase) + Drizzle | AgentsView already pushes to Postgres — direct import path for existing users |
| Auth | GitHub + Google OAuth | GitHub is the norm here and gives a free identity/avatar |
| Realtime | `LISTEN/NOTIFY` → SSE | AgentsView uses SSE too; no websocket infra to run |
| Jobs | pg-boss | Season rollover, daily decay, circle shrink, duel settlement |
| Self-host | single `docker-compose.yml` | burnlog set this expectation; org buyers will ask |

---

## 9. Build order

- **M0 — Ingest (wk 1).** Payload schema, ed25519 device keys, Claude Code reader, hourly bucketing, Postgres schema, raw Burn board only. Dogfood solo.
- **M1 — Parity (wk 2).** OAuth, handles, visibility modes, clubs via invite code. *Usurp now matches ccclub.*
- **M2 — Rating (wk 3).** Scoring engine, **simulation harness + ship gate (`#4.4`)**, decay, Throne/reign tracking, dethrone events, arena feed. *This is the differentiator — do not skip to M3.*
- **M3 — Battle royale (wk 4).** Seasons, shrinking circles, duels, notifications (email / webhook / Slack), share cards.
- **M4 — Org.** Domain verification, admin consent model, aggregate-only admin views, Admin-API cross-verification, Codex + remaining agents.

---

## 10. Privacy commitments (publish these)

1. Prompts, code, file paths, repo names and cwd never leave the machine — hourly aggregate counters only.
2. 100% opt-in; every arena independently leavable; account deletion purges `usage_events`.
3. Org admins see aggregates only unless a member opts to be public in that arena.
4. CLI open source (MIT); payload schema documented; whole app self-hostable.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Crowded market, no wedge | The four-way combination in `#1`; kill if M2's gate fails |
| Rewards token waste | `#4` two-board split, log volume, efficiency multiplier, simulated ship gate |
| Forged submissions | `#3.4` signing, trust tiers, plausibility gates, shadow-freeze |
| Org privacy backlash | `#2` opt-in + aggregate-only admin views as an invariant |
| Notification fatigue | `#5` rate limits |
| Anthropic ships this natively ([issue #69327](https://github.com/anthropics/claude-code/issues/69327)) | Multi-agent + clubs + self-host are outside what a first-party feature would cover |

---

## 12. Competitive landscape (as of 2026-09-08)

| Product | Auth | Scopes | Gamification |
|---|---|---|---|
| [ccclub](https://ccclub.dev/) | none (invite codes) | private clubs | none |
| [Fancysauce](https://fancysauce.ai/leaderboard) | slash-command login | personal + team | streaks, 1-click challenge |
| [CCgather](https://ccgather.com/) | OAuth | global + 40 countries | 10 levels, 27 badges |
| [Viberank](https://www.viberank.app/) | GitHub | global, per-tool, 7/30/all | 6 tiers |
| [TokenArena](https://token-arena.vercel.app/) | GitHub | global d/w/m | named badges, anon mode |
| [burnlog](https://burnlog.net/) | GitHub | global + weekly | 11 log ranks; self-hostable |
| [Token Leaders](https://tokenleaders.fun/) | — | global | board only |
| [claude-code-leaderboard](https://github.com/grp06/claude-code-leaderboard) | Twitter | global | board only |
| [AgentsView](https://github.com/kenn-io/agentsview) | n/a, local-first | n/a | **none** — deep analytics, no league |

Prior art worth reading before building: the [token-leaderboard anti-pattern critique](https://gist.github.com/yurukusa/ac41d467d97f3711129070d8e311db4f) and [The Pragmatic Engineer on "tokenmaxxing"](https://blog.pragmaticengineer.com/the-pulse-tokenmaxxing-as-a-weird-new-trend/).
