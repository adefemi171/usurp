import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { userProfile } from "./profile.js";

/** Controllable lazy reads: no wall-clock performance thresholds or real pool. */
function controlledDb() {
  const started: number[] = [];
  const reads: Array<{
    resolve: (rows: unknown[]) => void;
    reject: (error: Error) => void;
  }> = [];
  const select = vi.fn(() => {
    const index = reads.length;
    let resolve!: (rows: unknown[]) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    reads.push({ resolve, reject });
    const query = {
      from: () => query,
      where: () => query,
      innerJoin: () => query,
      groupBy: () => query,
      orderBy: () => query,
      limit: () => query,
      then: (...args: Parameters<typeof promise.then>) => {
        started.push(index);
        return promise.then(...args);
      },
    };
    return query;
  });
  return { db: { select } as unknown as Db, reads, started };
}

const user = {
  id: "owner", handle: "public-handle", avatarUrl: null,
  createdAt: new Date("2026-09-01Z"), reviewState: "clear",
};
const arena = { slug: "global", name: "Global", type: "global" };

describe("profile read scheduling", () => {
  it("waits for authorization, then starts all independent summaries together", async () => {
    const { db, reads, started } = controlledDb();
    const result = userProfile(db, user.handle, { window: "all", dailyAnalytics: true });
    await vi.waitFor(() => expect(started).toEqual([0]));
    expect(reads).toHaveLength(1);
    reads[0]!.resolve([user]);
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    expect(reads).toHaveLength(2);
    reads[1]!.resolve([arena]);
    // None of the summaries has resolved yet: all seven must already be running.
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    for (const read of reads.slice(2)) read.resolve([]);
    expect(await result).toMatchObject({ handle: user.handle, totals: { calls: 0 } });
  });

  it("never starts usage or bridge reads when the visibility gate denies access", async () => {
    const { db, reads } = controlledDb();
    const result = userProfile(db, user.handle, { dailyAnalytics: true, viewerId: "stranger" });
    reads[0]!.resolve([user]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!.resolve([]);
    expect(await result).toBeUndefined();
    expect(reads).toHaveLength(2);
  });

  it("allows a private owner but skips bridge reads unless daily analytics is requested", async () => {
    const { db, reads, started } = controlledDb();
    const result = userProfile(db, user.handle, { viewerId: user.id });
    reads[0]!.resolve([user]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!.resolve([]);
    await vi.waitFor(() => expect(started).toHaveLength(8));
    for (const read of reads.slice(2)) read.resolve([]);
    expect(await result).toMatchObject({ arenas: [], bridgeImports: [] });
    expect(reads).toHaveLength(8);
  });

  it("fails the request if a parallel read fails instead of showing partial or zero usage", async () => {
    const { db, reads, started } = controlledDb();
    const result = userProfile(db, user.handle, { dailyAnalytics: true });
    const rejected = expect(result).rejects.toThrow("database unavailable");
    reads[0]!.resolve([user]);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!.resolve([arena]);
    await vi.waitFor(() => expect(started).toHaveLength(9));
    reads[2]!.reject(new Error("database unavailable"));
    for (const read of reads.slice(3)) read.resolve([]);
    await rejected;
  });
});
