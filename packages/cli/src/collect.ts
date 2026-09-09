/**
 * Read local agent data and fold it into buckets.
 *
 * Shared by `sync` and `preview` so that what `preview` shows is byte-identical
 * to what `sync` sends. A preview that renders a different code path is a
 * privacy claim nobody should believe.
 */

import { GitCommitCounter, NullCommitCounter, defaultReaders, toBuckets } from "@usurp/readers";
import { MAX_BUCKET_AGE_MS, type Bucket } from "@usurp/protocol";
import type { ReaderResult } from "@usurp/readers";

/**
 * How far back a first sync reaches. `#3.4` refuses buckets older than 90
 * days, so reaching further would only generate rejections.
 */
export const FIRST_SYNC_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Overlap re-read on every subsequent sync.
 *
 * The hour in progress at the last sync was only partially observed — a session
 * still running then has since finished. Re-reading a few hours lets the
 * server's `GREATEST` upsert repair those counters. Without the overlap, the
 * boundary hour stays permanently understated.
 */
export const SYNC_OVERLAP_MS = 3 * 60 * 60 * 1000;

/** Normal sync horizon; `--all` separately imports older analytics history. */
export const MAX_LOOKBACK_MS = MAX_BUCKET_AGE_MS;

export function resolveSince(input: {
  lastSyncAt?: string;
  all?: boolean;
  now: Date;
}): Date | undefined {
  if (input.all) return undefined;

  const floor = new Date(input.now.getTime() - MAX_LOOKBACK_MS);

  if (!input.lastSyncAt) {
    return new Date(input.now.getTime() - FIRST_SYNC_LOOKBACK_MS);
  }

  const last = Date.parse(input.lastSyncAt);
  if (!Number.isFinite(last)) {
    return new Date(input.now.getTime() - FIRST_SYNC_LOOKBACK_MS);
  }

  const since = new Date(last - SYNC_OVERLAP_MS);
  return since < floor ? floor : since;
}

export interface CollectOptions {
  deviceId: string;
  since?: Date;
  now?: Date;
  /** Skip git entirely. `commits` stays 0. */
  noGit?: boolean;
  /** Mark data outside the normal ingest horizon as analytics-only history. */
  all?: boolean;
}

export interface Collected {
  buckets: Bucket[];
  reads: Array<{ agent: string; result: ReaderResult }>;
  warnings: string[];
}

export async function collect(options: CollectOptions): Promise<Collected> {
  const now = options.now ?? new Date();
  const commits = options.noGit ? new NullCommitCounter() : new GitCommitCounter();

  const merged: ReaderResult = { calls: [], edits: [], sessions: [], warnings: [] };
  const reads: Collected["reads"] = [];

  for (const reader of defaultReaders()) {
    if (!(await reader.detect())) continue;

    const result = await reader.read({
      ...(options.since ? { since: options.since } : {}),
      now,
    });
    reads.push({ agent: reader.id, result });

    merged.calls.push(...result.calls);
    merged.edits.push(...result.edits);
    merged.sessions.push(...result.sessions);
    merged.warnings.push(...result.warnings);
  }

  // One bucketing pass over every reader's output, so a bucket key shared by
  // two agents cannot produce two rows with colliding dedupe keys.
  const rawBuckets = await toBuckets(merged, { deviceId: options.deviceId, commits });
  const buckets = markHistorical(rawBuckets, now, options.all ?? false);

  return { buckets, reads, warnings: merged.warnings };
}

export function markHistorical(buckets: Bucket[], now: Date, all: boolean): Bucket[] {
  return buckets.map((bucket) =>
    all && now.getTime() - Date.parse(bucket.hour) > MAX_BUCKET_AGE_MS
      ? { ...bucket, historical: true as const }
      : bucket,
  );
}

/** Bound both preview and sync requests below schema and HTTP size limits. */
export function batchBuckets(buckets: Bucket[]): Bucket[][] {
  const batches: Bucket[][] = [];
  for (let offset = 0; offset < buckets.length; offset += 500) {
    batches.push(buckets.slice(offset, offset + 500));
  }
  return batches;
}

export function summarize(buckets: Bucket[]) {
  return buckets.reduce(
    (acc, b) => ({
      effectiveTokens:
        acc.effectiveTokens + b.input_tokens + b.output_tokens + b.cache_write_tokens,
      cacheReadTokens: acc.cacheReadTokens + b.cache_read_tokens,
      calls: acc.calls + b.calls,
      sessions: acc.sessions + b.sessions_started,
      edits: acc.edits + b.edits_applied,
      commits: acc.commits + b.commits,
      costMicros: acc.costMicros + b.cost_micros,
    }),
    {
      effectiveTokens: 0,
      cacheReadTokens: 0,
      calls: 0,
      sessions: 0,
      edits: 0,
      commits: 0,
      costMicros: 0,
    },
  );
}
