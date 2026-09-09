import { describe, expect, it } from "vitest";
import { MAX_BUCKET_AGE_MS, type Bucket } from "@usurp/protocol";
import { markHistorical, resolveSince } from "./collect.js";

describe("archive selection", () => {
  const now = new Date("2026-09-09T12:00:00Z");
  const atAge = (age: number) => ({ hour: new Date(now.getTime() - age).toISOString() }) as Bucket;

  it("marks only buckets beyond the normal ingest horizon, without changing their identity", () => {
    const buckets = [atAge(0), atAge(MAX_BUCKET_AGE_MS), atAge(MAX_BUCKET_AGE_MS + 3_600_000)];
    expect(markHistorical(buckets, now, true)).toEqual([
      buckets[0], buckets[1], { ...buckets[2], historical: true },
    ]);
    expect(buckets[2]?.historical).toBeUndefined();
  });

  it("does not mark normal syncs as historical", () => {
    const buckets = [atAge(MAX_BUCKET_AGE_MS + 1)];
    expect(markHistorical(buckets, now, false)).toEqual(buckets);
  });

  it("removes the read cutoff only when all history is explicitly requested", () => {
    expect(resolveSince({ now, all: true, lastSyncAt: now.toISOString() })).toBeUndefined();
    expect(resolveSince({ now })).toBeInstanceOf(Date);
  });
});
