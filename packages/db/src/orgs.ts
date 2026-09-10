import { createHash, randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  arenaMembers,
  arenas,
  identities,
  orgDomains,
  devices,
  usageBridgeSnapshots,
} from "./schema.js";
import { mergeBridgeSeries } from "./bridge.js";
import type { UsageSeriesPoint } from "./profile.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function normalizeOrgDomain(value: string) {
  const domain = value.trim().toLowerCase();
  if (
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  )
    throw new Error("invalid_domain");
  if (
    [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "yahoo.com",
      "icloud.com",
      "proton.me",
    ].includes(domain)
  )
    throw new Error("personal_email_domain");
  return domain;
}

export async function createOrg(
  db: Db,
  userId: string,
  name: string,
  rawDomain: string,
  now = new Date(),
) {
  const domain = normalizeOrgDomain(rawDomain);
  if (name.trim().length < 2 || name.length > 48)
    throw new Error("invalid_name");
  const token = `usurp-verification=${randomBytes(24).toString("base64url")}`;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`org-owner:${userId}`},0))`,
    );
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(arenas)
      .where(and(eq(arenas.ownerUserId, userId), eq(arenas.type, "org")));
    if (count!.n >= 3) throw new Error("org_limit");
    const [arena] = await tx
      .insert(arenas)
      .values({
        name: name.trim(),
        type: "org",
        slug: `org-${randomBytes(8).toString("hex")}`,
        ownerUserId: userId,
      })
      .returning();
    await tx
      .insert(orgDomains)
      .values({
        arenaId: arena!.id,
        domain,
        challengeHash: digest(token),
        expiresAt: new Date(now.getTime() + 7 * 86400_000),
      });
    return { arena: arena!, record: `_usurp.${domain}`, value: token };
  });
}

export async function verifyOrg(
  db: Db,
  userId: string,
  arenaId: string,
  now = new Date(),
  lookup = resolveTxt,
) {
  const [claim] = await db
    .select({ claim: orgDomains })
    .from(orgDomains)
    .innerJoin(arenas, eq(arenas.id, orgDomains.arenaId))
    .where(and(eq(arenas.id, arenaId), eq(arenas.ownerUserId, userId)));
  if (!claim) throw new Error("not_owner");
  if (claim.claim.verifiedAt) return true;
  if (claim.claim.expiresAt <= now) throw new Error("verification_expired");
  let records: string[][];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    records = await Promise.race([
      lookup(`_usurp.${claim.claim.domain}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("dns_timeout")), 5000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
  if (
    !records.some(
      (parts) => digest(parts.join("")) === claim.claim.challengeHash,
    )
  )
    return false;
  // Partial unique index arbitrates simultaneous claims by different accounts.
  const updated = await db
    .update(orgDomains)
    .set({ verifiedAt: now })
    .where(
      and(
        eq(orgDomains.arenaId, arenaId),
        eq(orgDomains.challengeHash, claim.claim.challengeHash),
      ),
    )
    .returning();
  return updated.length === 1;
}

/** Recover a lost or expired DNS challenge without making another organization. */
export async function renewOrgChallenge(
  db: Db,
  userId: string,
  arenaId: string,
  now = new Date(),
) {
  const token = `usurp-verification=${randomBytes(24).toString("base64url")}`;
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select()
      .from(arenas)
      .where(and(eq(arenas.id, arenaId), eq(arenas.ownerUserId, userId)))
      .for("update");
    if (!owned) throw new Error("not_owner");
    const [claim] = await tx
      .select()
      .from(orgDomains)
      .where(eq(orgDomains.arenaId, arenaId))
      .for("update");
    if (!claim || claim.verifiedAt) throw new Error("not_pending");
    await tx
      .update(orgDomains)
      .set({
        challengeHash: digest(token),
        expiresAt: new Date(+now + 7 * 86400_000),
      })
      .where(eq(orgDomains.arenaId, arenaId));
    return { record: `_usurp.${claim.domain}`, value: token };
  });
}

export async function joinOrg(
  db: Db,
  userId: string,
  arenaId: string,
  consent: boolean,
) {
  if (consent !== true) throw new Error("consent_required");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`org-member:${userId}`},0))`,
    );
    const [org] = await tx
      .select()
      .from(orgDomains)
      .where(
        and(eq(orgDomains.arenaId, arenaId), isNotNull(orgDomains.verifiedAt)),
      );
    if (!org) throw new Error("org_not_verified");
    // Never trust the legacy emailDomain field or a typed address as proof.
    const emails = await tx
      .select()
      .from(identities)
      .where(
        and(eq(identities.userId, userId), eq(identities.provider, "email")),
      );
    if (!emails.some((e) => e.providerUid.split("@")[1] === org.domain))
      throw new Error("verified_work_email_required");
    const current = await tx
      .select({ id: arenas.id })
      .from(arenaMembers)
      .innerJoin(arenas, eq(arenas.id, arenaMembers.arenaId))
      .where(
        and(
          eq(arenaMembers.userId, userId),
          eq(arenas.type, "org"),
          sql`${arenaMembers.status} <> 'left'`,
        ),
      );
    if (current.some((a) => a.id !== arenaId))
      throw new Error("already_in_org");
    await tx
      .insert(arenaMembers)
      .values({ arenaId, userId, visibility: "hidden", status: "active" })
      .onConflictDoUpdate({
        target: [arenaMembers.arenaId, arenaMembers.userId],
        set: { visibility: "hidden", status: "active", joinedAt: new Date() },
        setWhere: eq(arenaMembers.status, "left"),
      });
  });
}

/** Fixed completed calendar week, no member/model filters or individual identifiers. */
export async function orgAggregate(
  db: Db,
  ownerId: string,
  arenaId: string,
  now = new Date(),
) {
  const [owned] = await db
    .select({ id: arenas.id })
    .from(arenas)
    .innerJoin(orgDomains, eq(orgDomains.arenaId, arenas.id))
    .where(
      and(
        eq(arenas.id, arenaId),
        eq(arenas.ownerUserId, ownerId),
        isNotNull(orgDomains.verifiedAt),
      ),
    );
  if (!owned) return null;
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  to.setUTCDate(to.getUTCDate() - ((to.getUTCDay() + 6) % 7));
  const from = new Date(to.getTime() - 7 * 86400_000);
  const members = await db
    .select({ userId: arenaMembers.userId, joinedAt: arenaMembers.joinedAt })
    .from(arenaMembers)
    .where(
      and(
        eq(arenaMembers.arenaId, arenaId),
        sql`${arenaMembers.status} <> 'left'`,
      ),
    );
  const native =
    await db.execute(sql`select u.user_id, u.device_id, to_char(u.hour at time zone 'UTC','YYYY-MM-DD') as day,
    u.agent,u.model,sum(u.input_tokens)::text as input,sum(u.output_tokens)::text as output,
    sum(u.cache_write_tokens)::text as writes,sum(u.cache_read_tokens)::text as reads,
    sum(u.cost_micros)::text as cost,count(*) filter (where u.flags @> '["unknown_model"]'::jsonb)::int as unpriced
    from usage_events u join arena_members m on m.user_id=u.user_id and m.arena_id=${arenaId}
    where m.status <> 'left' and u.hour >= ${from.toISOString()}::timestamptz and u.hour < ${to.toISOString()}::timestamptz and u.hour >= m.joined_at
    group by u.user_id,u.device_id,day,u.agent,u.model`);
  const snapshots = await db
    .select({
      userId: devices.userId,
      deviceId: devices.id,
      snapshot: usageBridgeSnapshots.snapshot,
    })
    .from(usageBridgeSnapshots)
    .innerJoin(devices, eq(devices.id, usageBridgeSnapshots.deviceId))
    .innerJoin(
      arenaMembers,
      and(
        eq(arenaMembers.userId, devices.userId),
        eq(arenaMembers.arenaId, arenaId),
      ),
    )
    .where(sql`${arenaMembers.status} <> 'left'`);
  let contributors = 0,
    tokens = 0,
    cost = 0,
    unpriced = 0;
  for (const member of members) {
    const rows = native
      .filter((r) => r.user_id === member.userId)
      .map((r) => ({
        deviceId: String(r.device_id),
        day: String(r.day),
        agent: String(r.agent),
        model: String(r.model),
        inputTokens: Number(r.input),
        outputTokens: Number(r.output),
        cacheWriteTokens: Number(r.writes),
        cacheReadTokens: Number(r.reads),
        effectiveTokens: Number(r.input) + Number(r.output) + Number(r.writes),
        costMicros: Number(r.cost),
        unpricedBuckets: Number(r.unpriced),
        calls: 0,
        sessionsStarted: 0,
        sessionsCompleted: 0,
        sessionsAbandoned: 0,
        editsApplied: 0,
        editsReverted: 0,
        commits: 0,
        historicalBuckets: 0,
      })) satisfies Array<UsageSeriesPoint & { deviceId: string }>;
    // Daily exports cannot separate activity before consent within the join day.
    const firstBridgeDay = new Date(
      Math.ceil(+member.joinedAt / 86400_000) * 86400_000,
    )
      .toISOString()
      .slice(0, 10);
    const selected = snapshots
      .filter((s) => s.userId === member.userId)
      .map((s) => ({
        ...s,
        snapshot: {
          ...s.snapshot,
          rows: s.snapshot.rows.filter(
            (r) =>
              r.day >= firstBridgeDay &&
              r.day >= from.toISOString().slice(0, 10) &&
              r.day < to.toISOString().slice(0, 10),
          ),
        },
      }));
    const merged = mergeBridgeSeries(rows, selected);
    if (
      !merged.some(
        (r) => r.effectiveTokens + r.cacheReadTokens + r.costMicros > 0,
      )
    )
      continue;
    contributors++;
    for (const row of merged) {
      tokens += row.effectiveTokens;
      cost += row.costMicros;
      unpriced += row.unpricedBuckets;
    }
  }
  if (contributors < 5)
    return { from, to, suppressed: true, minimumContributors: 5 };
  return {
    from,
    to,
    suppressed: false,
    tokens: String(tokens),
    costMicros: String(cost),
    costComplete: unpriced === 0,
    costBasis: "selected native/AgentsView sources; may include estimates",
  };
}

export async function ownedOrgs(db: Db, userId: string) {
  return db
    .select({
      id: arenas.id,
      name: arenas.name,
      slug: arenas.slug,
      domain: orgDomains.domain,
      verifiedAt: orgDomains.verifiedAt,
    })
    .from(arenas)
    .innerJoin(orgDomains, eq(orgDomains.arenaId, arenas.id))
    .where(eq(arenas.ownerUserId, userId));
}
