/**
 * Model registry: context windows (for the throughput gates) and pricing (for
 * `cost_micros`).
 *
 * This is a local mirror, cached 2026-06-24, of Anthropic's first-party API
 * rates. It is deliberately a plain table rather than a live lookup: `usurp
 * sync` runs from a `SessionEnd` hook and must not make a network call to price
 * a bucket, and a board must be able to re-price historical buckets
 * deterministically. Rates drift — see `#refreshing` at the bottom.
 *
 * Partner platforms (Bedrock, Vertex) are separately priced and not covered
 * here; a bucket from those routes prices at first-party rates and is
 * approximate. Fine for a leaderboard, wrong for an invoice.
 */

/** Cache-write pricing depends on the TTL the caller asked for. */
export const CACHE_WRITE_MULTIPLIER_5M = 1.25;
export const CACHE_WRITE_MULTIPLIER_1H = 2.0;
/** Cache reads are ~10% of the input rate — the whole point of caching. */
export const CACHE_READ_MULTIPLIER = 0.1;

export interface ModelInfo {
  /** Exact API model ID. Never date-suffixed. */
  id: string;
  /** Max input tokens per call. The basis of the per-call plausibility gate. */
  contextWindow: number;
  /** USD per million input tokens. */
  inputUsdPerMTok: number;
  /** USD per million output tokens. */
  outputUsdPerMTok: number;
  /** Applied per request, to total input including cached input. */
  longContext?: { above: number; input: number; output: number };
}

const MODELS: readonly ModelInfo[] = [
  { id: "claude-fable-5-1", contextWindow: 1_000_000, inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  { id: "claude-fable-5", contextWindow: 1_000_000, inputUsdPerMTok: 10, outputUsdPerMTok: 50 },
  { id: "claude-opus-5", contextWindow: 1_000_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { id: "claude-opus-4-8", contextWindow: 1_000_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { id: "claude-opus-4-7", contextWindow: 1_000_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { id: "claude-opus-4-6", contextWindow: 1_000_000, inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
  { id: "claude-sonnet-5", contextWindow: 1_000_000, inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  { id: "claude-sonnet-4-6", contextWindow: 1_000_000, inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  { id: "claude-haiku-4-5", contextWindow: 200_000, inputUsdPerMTok: 1, outputUsdPerMTok: 5 },

  /*
   * ── Non-Anthropic models, reached through Copilot ────────────────────────
   *
   * `#3.1` puts other agents in scope, and VS Code Copilot routes to whichever
   * model the user picked. Measured on one development machine, 46% of model
   * spend went through Copilot, so leaving these unpriced would leave the Burn
   * board's cost column reading zero for half the field.
   *
   * Comparison-price caveats:
   *
   * 1. Copilot does not bill per token. It bills subscription "premium
   *    requests" — the request records carry `copilotCredits`, not dollars.
   *    These rates therefore price *what the tokens would have cost at the
   *    vendor's list API rate*, which is the only basis on which two agents
   *    can be compared, and is the same basis AgentsView uses. It is not an
   *    invoice, and `#4.2` scores on tokens rather than dollars, so no ranking
   *    depends on it.
   *
   * 2. Context bands apply per request BEFORE hourly aggregation, including
   *    cached input in the context size. Pricing an hourly sum as one request
   *    silently overcharges many short calls.
   * 3. Windows here are generous validation ceilings, not a product capability
   *    guarantee. Unknown models remain explicitly unpriced.
   */
  // Reference-rate snapshot: AgentsView model_pricing/model_pricing_bands,
  // 2026-09-09. Cached locally; AgentsView is NOT a runtime dependency.
  // These are comparison estimates, not subscription charges.
  { id: "gpt-5.6-sol", contextWindow: 1_000_000, inputUsdPerMTok: 4, outputUsdPerMTok: 20, longContext: { above: 272_000, input: 8, output: 30 } },
  { id: "gpt-5.6-terra", contextWindow: 1_000_000, inputUsdPerMTok: 2, outputUsdPerMTok: 12, longContext: { above: 272_000, input: 4, output: 18 } },
  { id: "gpt-5.6-luna", contextWindow: 1_000_000, inputUsdPerMTok: 0.2, outputUsdPerMTok: 1.2, longContext: { above: 272_000, input: 0.4, output: 1.8 } },
  { id: "gpt-6-astra", contextWindow: 1_000_000, inputUsdPerMTok: 10, outputUsdPerMTok: 50, longContext: { above: 272_000, input: 20, output: 75 } },
  { id: "gpt-5.5", contextWindow: 400_000, inputUsdPerMTok: 5, outputUsdPerMTok: 30 },
  { id: "gpt-5.4", contextWindow: 400_000, inputUsdPerMTok: 2.5, outputUsdPerMTok: 15 },
  { id: "gpt-5.4-mini", contextWindow: 400_000, inputUsdPerMTok: 0.75, outputUsdPerMTok: 4.5 },
  { id: "gpt-5.3-codex", contextWindow: 400_000, inputUsdPerMTok: 1.75, outputUsdPerMTok: 14 },
  { id: "gpt-5-mini", contextWindow: 400_000, inputUsdPerMTok: 0.25, outputUsdPerMTok: 2 },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

/**
 * Fall back for a model we've never seen — a newly released one, or another
 * vendor's once the reader set grows past Claude.
 *
 * The window is generous and the price is zero on purpose. A too-tight window
 * would reject a legitimate heavy user of a brand-new model, which `#3.4` calls
 * out as the worse error; a zero price keeps an unpriced model out of the Burn
 * board's cost column rather than inventing a number. Both are visible: the
 * server flags the bucket `unknown_model` so the gap is findable.
 */
const UNKNOWN_MODEL_WINDOW = 2_000_000;

/**
 * Resolve a model ID, tolerating the variant suffixes Claude Code writes into
 * transcripts (`claude-opus-5[1m]`) and provider prefixes (`anthropic.` on
 * Bedrock, `@`-versioned IDs on Vertex).
 */
export function lookupModel(rawId: string): ModelInfo | undefined {
  const id = normalizeModelId(rawId);
  return BY_ID.get(id);
}

/** Strip provider prefixes and variant suffixes down to the first-party ID. */
export function normalizeModelId(rawId: string): string {
  let id = rawId.trim().toLowerCase();
  // Bedrock: "anthropic.claude-opus-5"
  if (id.startsWith("anthropic.")) id = id.slice("anthropic.".length);
  // Vertex dated snapshots: "claude-opus-4-5@20251101"
  const at = id.indexOf("@");
  if (at !== -1) id = id.slice(0, at);
  // Claude Code context/variant marker: "claude-opus-5[1m]"
  const bracket = id.indexOf("[");
  if (bracket !== -1) id = id.slice(0, bracket);
  /*
   * Dated snapshot suffixes: "claude-haiku-4-5-20251001" (Anthropic's compact
   * form) and "gpt-5.5-2026-04-23" (the dashed form Copilot records).
   *
   * Both are real API ids and both alias the same model at the same price, so
   * the table holds only the undated form. Found by the Copilot reader, which
   * surfaced 15 calls of `claude-haiku-4-5-20251001` priced at zero and
   * flagged `unknown_model` — the flag was doing its job.
   */
  id = id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  // Strip only known model parameter suffixes, never arbitrary model names.
  const base = id.replace(/(?:-thinking)?-(?:minimal|low|medium|high|xhigh|max|ultra)$/, "").replace(/-thinking$/, "");
  if (BY_ID.has(base)) id = base;
  return id;
}

/** Context window used by the gates. Generous default for unknown models. */
export function contextWindowFor(rawId: string): number {
  return lookupModel(rawId)?.contextWindow ?? UNKNOWN_MODEL_WINDOW;
}

export function isKnownModel(rawId: string): boolean {
  return lookupModel(rawId) !== undefined;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Cache writes with the default 5-minute TTL. */
  cacheWrite5mTokens?: number;
  /** Cache writes with the 1-hour TTL, which bill at a higher multiplier. */
  cacheWrite1hTokens?: number;
  cacheReadTokens: number;
}

/**
 * Price a set of token counts in integer micro-dollars.
 *
 * Micros, not floats: `canonical.ts` refuses to sign a non-integer, precisely
 * so no float ever reaches the signing input. Since USD-per-MTok is the rate,
 * `micros == tokens * usdPerMTok` exactly, with no intermediate division.
 */
export function costMicros(rawId: string, counts: TokenCounts, bandMode: "auto" | "base" = "auto"): number {
  const model = lookupModel(rawId);
  // Unknown model: no invented price. The bucket still counts toward tokens.
  if (!model) return 0;

  const context = counts.inputTokens + counts.cacheReadTokens + (counts.cacheWrite5mTokens ?? 0) + (counts.cacheWrite1hTokens ?? 0);
  const band = bandMode === "auto" && model.longContext && context > model.longContext.above ? model.longContext : undefined;
  const input = band?.input ?? model.inputUsdPerMTok;
  const output = band?.output ?? model.outputUsdPerMTok;
  const write5m = counts.cacheWrite5mTokens ?? 0;
  const write1h = counts.cacheWrite1hTokens ?? 0;

  return Math.round(
    counts.inputTokens * input +
      counts.outputTokens * output +
      write5m * input * CACHE_WRITE_MULTIPLIER_5M +
      write1h * input * CACHE_WRITE_MULTIPLIER_1H +
      counts.cacheReadTokens * input * CACHE_READ_MULTIPLIER,
  );
}

/** Every model the registry knows, for docs and admin tooling. */
export function knownModels(): readonly ModelInfo[] {
  return MODELS;
}

/*
 * #refreshing
 * Rates and windows change, and a stale table quietly misprices the Burn board.
 * Re-check against the published pricing page when adding a model, and treat
 * the `unknown_model` flag count on `usage_events` as the signal that this
 * table has fallen behind.
 */
