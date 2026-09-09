import { z } from "zod";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Node 22 fetch ignores a custom Host header. Use the standard HTTP transport
// for the fixed Docker gateway, with bounded bodies and no redirect following.
async function dockerRequest(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { headers, signal }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) { request.destroy(new Error("AgentsView response exceeds 8 MB")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: response.statusCode ?? 502 })));
    });
    request.on("error", reject); request.end();
  });
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const date = new Date(v); return Number.isFinite(+date) && date.toISOString().slice(0, 10) === v;
});
export const bridgeRowSchema = z.object({
  day, agent: z.string().min(1).max(64), model: z.string().min(1).max(128),
  inputTokens: count, outputTokens: count, cacheWriteTokens: count, cacheReadTokens: count,
  costMicros: count, costAvailable: z.boolean(),
}).strict();
/** Daily analytics, never fabricated hourly events or competitive scores. */
export const bridgeSnapshotSchema = z.object({
  source: z.literal("agentsview"), schemaVersion: z.literal(6),
  fetchedAt: z.string().datetime(), timezone: z.literal("UTC"),
  pricingVersion: z.string().max(256), costBasis: z.literal("source-calculated"),
  agents: z.array(z.string().min(1).max(64)).min(1).max(64),
  rows: z.array(bridgeRowSchema).min(1).max(10000),
}).strict().superRefine((s, ctx) => {
  const seen = new Set<string>();
  if (new Set(s.agents).size !== s.agents.length) ctx.addIssue({ code: "custom", message: "Duplicate agent" });
  for (const r of s.rows) {
    const key = JSON.stringify([r.day, r.agent, r.model]);
    if (!s.agents.includes(r.agent) || seen.has(key) || r.day > s.fetchedAt.slice(0, 10))
      ctx.addIssue({ code: "custom", message: "Invalid snapshot coverage" });
    seen.add(key);
  }
});
export type BridgeSnapshot = z.infer<typeof bridgeSnapshotSchema>;

const money = z.object({ microdollars: count });
const counters = { inputTokens: count, outputTokens: count, cacheCreationTokens: count, cacheReadTokens: count };
const summarySchema = z.object({
  schema_version: z.literal(6),
  totals: z.object({ ...counters, totalCost: money }),
  agentTotals: z.array(z.object({ agent: z.string().min(1).max(64) })),
  daily: z.array(z.object({ date: day, ...counters, totalCost: money,
    modelBreakdowns: z.array(z.object({ modelName: z.string().min(1).max(128), ...counters, cost: money })) })),
  pricing: z.object({ table_version: z.string(), models: z.record(z.object({
    cost_source: z.string(), resolutions: z.array(z.object({ matched_pattern: z.string().nullable() })),
  })) }),
});

/** Only explicitly configured local bridges. No arbitrary remote URL or redirects. */
export function bridgeUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    !["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(url.hostname) ||
    url.pathname !== "/" || url.search || url.hash) throw new Error("AgentsView URL must be a local origin, e.g. http://localhost:8080");
  return url;
}

/** Read only usage summaries; project/session fields are discarded at this boundary. */
export async function fetchBridgeSnapshot(raw: string, request: typeof fetch = fetch): Promise<BridgeSnapshot> {
  const base = bridgeUrl(raw);
  const signal = AbortSignal.timeout(20_000);
  async function summary(agent?: string) {
    const url = new URL("/api/v1/usage/summary", base);
    url.search = new URLSearchParams({ no_default_range: "true", timezone: "UTC", session_counts: "false", ...(agent ? { agent } : {}) }).toString();
    // Docker's gateway is a transport address for the same local service.
    // Preserve its canonical localhost authority, as a reverse proxy would.
    // The transport is restricted by bridgeUrl; browser input cannot set it.
    const headers: Record<string, string> = { "cache-control": "no-cache" };
    if (base.hostname === "host.docker.internal") headers.host = `localhost${base.port ? `:${base.port}` : ""}`;
    const response = base.hostname === "host.docker.internal" && request === fetch
      ? await dockerRequest(url, headers, signal)
      : await request(url, { signal, redirect: "error", headers });
    if (!response.ok) throw new Error(`AgentsView returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty AgentsView response");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("AgentsView response exceeds 8 MB"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return summarySchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }
  const overall = await summary();
  const agents = [...new Set(overall.agentTotals.map(a => a.agent))];
  if (!agents.length || agents.length > 64) throw new Error("No supported AgentsView usage available");
  const rows: BridgeSnapshot["rows"] = [];
  for (const agent of agents) {
    const data = await summary(agent);
    if (data.pricing.table_version !== overall.pricing.table_version) throw new Error("AgentsView pricing changed during import; refresh again");
    for (const d of data.daily) {
      for (const m of d.modelBreakdowns) {
        const pricing = data.pricing.models[m.modelName];
        rows.push({ day: d.date, agent, model: m.modelName, inputTokens: m.inputTokens,
          outputTokens: m.outputTokens, cacheWriteTokens: m.cacheCreationTokens, cacheReadTokens: m.cacheReadTokens,
          costMicros: m.cost.microdollars, costAvailable: m.cost.microdollars > 0 || pricing?.cost_source === "reported" ||
            !!pricing?.resolutions.some(r => r.matched_pattern !== null) });
      }
    }
  }
  // Fail closed if the source changed mid-read, omits models, or drifts schema.
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens"] as const;
  for (const field of fields) if (rows.reduce((n, r) => n + r[field], 0) !== overall.totals[field]) throw new Error("AgentsView totals changed during import; refresh again");
  if (rows.reduce((n, r) => n + r.cacheWriteTokens, 0) !== overall.totals.cacheCreationTokens ||
      rows.reduce((n, r) => n + r.costMicros, 0) !== overall.totals.totalCost.microdollars)
    throw new Error("AgentsView daily totals do not reconcile; previous snapshot retained");
  return bridgeSnapshotSchema.parse({ source: "agentsview", schemaVersion: 6, fetchedAt: new Date().toISOString(),
    timezone: "UTC", pricingVersion: overall.pricing.table_version, costBasis: "source-calculated", agents, rows });
}
