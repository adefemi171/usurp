/** Explicit, local-only Cursor dashboard export. No browser tokens are read.
 * Export one user's unfiltered usage for a continuous period. The export is
 * authoritative for that period; do not add it to native counters twice.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeModelId } from "@usurp/protocol";
import type { ApiCall } from "./types.js";

function csv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if (c === "\n" && !quoted) { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new Error("Unclosed quoted field");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

export function parseCursorUsage(text: string): ApiCall[] {
  const [header, ...rows] = csv(text.replace(/^\uFEFF/, ""));
  if (!header) throw new Error("Empty export");
  const names = header.map(s => s.trim().toLowerCase());
  const col = (...aliases: string[]) => names.findIndex(n => aliases.includes(n));
  const date = col("date", "timestamp"), model = col("model");
  const input = col("input (w/o cache write)", "input tokens"), output = col("output tokens"), read = col("cache read", "cache read tokens");
  const write = col("cache write", "cache write tokens"), withWrite = col("input (w/ cache write)");
  if ([date, model, input, output, read].some(c => c < 0)) throw new Error("Missing required usage columns");
  const amount = (row: string[], index: number): number => {
    const raw = row[index]?.replace(/,/g, "").trim();
    if (!raw || !/^\d+$/.test(raw)) throw new Error("Missing/invalid token count");
    const n = Number(raw); if (!Number.isSafeInteger(n)) throw new Error("Invalid token count"); return n;
  };
  return rows.map((row, index): ApiCall => {
    const at = row[date]?.trim() ?? "";
    // Refuse ambiguous locale timestamps; the sender must retain the timezone.
    if (!/(?:Z|[+-]\d\d:?\d\d)$/.test(at) || !Number.isFinite(Date.parse(at))) throw new Error("Timestamp must include timezone");
    const rawModel = row[model]?.trim(); if (!rawModel) throw new Error("Missing model");
    const uncached = amount(row, input);
    const writes = write >= 0 ? amount(row, write) : withWrite >= 0 ? amount(row, withWrite) - uncached : 0;
    if (writes < 0) throw new Error("Invalid cache split");
    return { agent: "cursor", model: normalizeModelId(rawModel), timestamp: new Date(at).toISOString(),
      inputTokens: uncached, outputTokens: amount(row, output), cacheReadTokens: amount(row, read),
      cacheWrite5mTokens: writes, cacheWrite1hTokens: 0, sessionId: "", cwd: "",
      messageId: createHash("sha256").update(JSON.stringify([index, at, rawModel, uncached, writes])).digest("hex") };
  }).filter(c => c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWrite5mTokens > 0);
}

export async function cursorUsageExport(path: string): Promise<ApiCall[]> {
  return parseCursorUsage(await readFile(path, "utf8"));
}
