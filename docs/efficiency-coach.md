# Efficiency coach: gaps and path to useful recommendations

Usurp's efficiency coach helps a member reduce AI-agent cost and wasted work
without collecting prompts, source code, project names, file paths, commands,
or tool arguments. This document defines what is shipped, what it cannot yet
know, and the work required to make its recommendations reliably useful.

## What exists today

The owner-only Usage overview displays explainable advice from the aggregate
usage data already in `usage_events`:

- low cache-read share relative to reported input tokens;
- a single model dominating priced usage;
- many native calls with few recorded edits;
- a privacy-preserving prompt toward local coaching and Runeward governance.

Members can mark an advice category **Useful** or **Not for me**. The choice is
stored in `efficiency_feedback` and useful categories are ranked first for that
member on future visits.

This is a *feedback-adaptive ranking*, not reinforcement learning. Rules still
select the candidate advice and a response does not prove that the advice caused
a saving. Keeping that distinction explicit avoids false claims about personal
data or model intelligence.

## Current limits

| Gap | Why it matters | Current behaviour |
| --- | --- | --- |
| No outcome measurement | A click is a preference, not proof of value. | Feedback only changes ranking. |
| No repeated-work evidence | The cloud service cannot see prompts, commands, tools, or repositories. | It cannot truthfully say a member repeated a command or failed to use a Skill. |
| Coarse hourly buckets | An hourly agent/model aggregate cannot connect an intervention to one task. | Advice uses broad trends and cautious wording. |
| No counterfactual | Cost can decline because work changed, not because advice helped. | No savings amount is claimed. |
| No recommendation quality gate | A plausible rule can still be noisy or unwelcome. | Manual thresholds and personal dismissal are the only guardrails. |
| No enforcement | Usurp observes activity after the fact. | Runeward is linked as the companion for policy, budget, approval, and sandbox gates. |
| Partial source coverage | AgentsView daily snapshots omit native call/edit counters; some models lack prices. | The coach must suppress dependent recommendations when the required counters are absent. |

## Non-negotiable privacy boundary

The hosted product must keep the existing data-minimization promise. It must not
add columns for prompt text, completion text, tool arguments, shell history,
repository names, current working directories, branches, file paths, or session
identifiers.

Richer evidence belongs in the installable **Usurp Connect** local service and
its browser controls. The service may inspect local records only after explicit
opt-in, then send one of the following instead of raw activity:

- an opaque recommendation category;
- a count and time window (for example, `repeated_validation_workflow: 7`);
- a local-only explanation retained on the computer;
- an optional before/after outcome summary approved by the member.

The website must show exactly which aggregate was shared and let the member turn
it off or delete it.

## What makes a recommendation useful

A recommendation should meet all of these conditions:

1. **Evidence:** cite a measured aggregate, its observation window, and source
   coverage.
2. **Actionability:** give one concrete next step, such as a stable cache
   prefix, `make check`, a Skill, `rg`, RTK, a hook, or a Runeward budget.
3. **Appropriate confidence:** use “may” when the aggregate is ambiguous; do
   not imply access to private workflow content.
4. **Reversibility:** recommend a low-risk experiment before a permanent change.
5. **Outcome definition:** say what should improve and when it will be checked.
6. **No fake savings:** show measured deltas only; never present a guessed value
   as money saved.

## Phased path to outcome-based learning

### Phase 1 — Make current advice measurable

Add an `advice_impressions` record when a card is shown. It should contain only
the member ID, recommendation category, version, timestamp, source coverage,
and a coarse feature bucket—not raw usage values or content.

When a member marks advice useful, offer an optional **I implemented this**
event and a selected intervention type:

- cache/prompt hygiene;
- lower-cost model routing;
- deterministic script or `make` target;
- Skill or saved command;
- hook/CI automation;
- Runeward budget/policy gate.

Define the check window at the time of the event (for example, 14 active days),
and measure only predeclared aggregate metrics such as cache-read share,
cost-per-active-day, calls-per-edit, and price-known token volume.

### Phase 2 — Add private local evidence

Extend Usurp Connect with a separate, disabled-by-default **Efficiency coach**
setting. It should classify repeated work locally using deterministic rules:

| Local observation | Local recommendation |
| --- | --- |
| Same validation sequence repeated three times | Create or use `make check`, a package script, hook, or CI job. |
| Repeated broad file search | Start with `rg`, git history, LSP, `jq`, or `ast-grep`. |
| Repeated procedure with reference material | Create a Skill. |
| Repeated prompt with some judgment | Create a saved command that invokes a deterministic script first. |
| Repeated no-judgment action | Invoke the script directly or automate it in a hook/CI. |
| High shell output exploration | Offer RTK when installed and applicable. |

The browser controls should present the local finding and explanation first.
Only the chosen category/count may be shared with Usurp, and sharing must be
separate from ordinary usage sync consent.

### Phase 3 — Learn ranking, not opaque actions

Use a contextual bandit or similarly conservative ranking model only after there
is enough opt-in outcome data. Its job is to choose the *order* of safe,
pre-approved recommendation templates—not generate policy or execute changes.

Input features must be coarse and privacy-safe: usage source coverage, cache
bucket, model-cost concentration bucket, call/edit ratio bucket, member's prior
feedback, and elapsed time since a similar recommendation. Never include prompt
or code embeddings in the hosted service.

Reward should be conservative:

```text
positive: member said useful + implemented + predeclared metric improved
neutral: no response, insufficient coverage, or no measurable change
negative: dismissed, reverted intervention, or metric materially regressed
```

Do not train across members until the product has explicit consent, minimum
cohort thresholds, retention limits, and an experiment review. Per-user ranking
is the safer first target.

### Phase 4 — Evaluate before claiming savings

Run recommendations as experiments with holdouts. Compare an intervention group
to a matched control window, report confidence intervals, and segment results by
data source. Track:

- useful rate and implementation rate;
- recommendation dismissal/reversion rate;
- change in the declared metric after implementation;
- cost per completed outcome where an outcome proxy is available;
- cache read/write ratio and known-price coverage;
- local workflow compilation rate;
- Runeward budget denials and approvals, when the member opts in.

Ship or retire a recommendation template based on measured helpfulness, not
click-through rate alone.

## Runeward boundary

[Runeward](https://runewardd.github.io/runeward/) is the enforcement companion,
not a source of hidden behavioural data. Usurp can recommend a Runeward policy
starter for budgets, approval thresholds, sandboxing, and dangerous-action
denial. A future integration may import only member-approved signed aggregates:
policy outcome, budget outcome, and a coarse prevented-cost value where
Runeward can substantiate it. It must not import agent prompts, workspace
contents, or audit payloads by default.

## AgentsView boundary

[AgentsView](https://github.com/kenn-io/agentsview) remains an optional,
local-first analytics source. Its daily snapshots can improve cost/model
coverage, but do not provide the native call/edit signals required for every
recommendation. The UI must label advice as unavailable rather than infer a
zero value from an AgentsView-only record.

## Definition of done

The coach is ready to describe itself as outcome-informed only when:

1. every recommendation has a versioned evidence rule and declared metric;
2. feedback, implementation, and outcome windows are opt-in and deletable;
3. insufficient source coverage suppresses advice rather than fabricating it;
4. local-only observations cannot be reconstructed from cloud data;
5. evaluation shows a sustained positive outcome against a control;
6. members can see why an advice card appeared, dismiss it, and stop future
   measurement.

