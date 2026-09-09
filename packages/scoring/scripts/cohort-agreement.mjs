/**
 * Measures the cost of `SPEC.md#6`'s global cohort against `#4.2`'s arena
 * cohort — the reproduction for the **44.6%** figure cited in `SPEC.md#4.2`.
 *
 * The two sections contradict each other. `#4.2` wants z-scores taken "against
 * the user's own arena cohort (so a hobbyist isn't scored against a monorepo
 * team)"; `#6` keys `daily_scores` on `(user_id, day)` with no arena column,
 * because a per-arena z-score would need one row per `(user, day, arena)` on
 * the hottest write path. The contradiction was resolved in favour of `#6`.
 *
 * This script exists so that decision is not defended by assertion. An earlier
 * claim that the choice "barely changes ordering" was **wrong**, and this is
 * what disproved it: within-club ordering agrees only ~44.6% of the time. That
 * is far above random (~8% for 12 positions) but nowhere near equivalent, so
 * `#6`'s consistency genuinely costs discrimination inside small cohorts.
 *
 * The second half checks the fairness worry `#4.2` actually voiced — that a
 * hobbyist would be crushed by a team's cohort. It is not where the difference
 * lives: `volume_pts` is absolute, not cohort-relative, so the volume gap is
 * identical either way. Only the efficiency multiplier moves.
 *
 * Run: `npm run cohort`
 */

import {
  ARCHETYPE_NAMES,
  dailyScore,
  getArchetype,
  makeRng,
  makeTraits,
  rawSignals,
  zScores,
} from "@usurp/scoring";

const CLUB_SIZE = 12;
const PLATFORM_SIZE = 500;
const DAYS = 28;
const STREAK_DAYS = 5;

const rng = makeRng(20260909);

const roster = [];
for (let i = 0; i < PLATFORM_SIZE; i++) {
  roster.push({ a: ARCHETYPE_NAMES[i % ARCHETYPE_NAMES.length], traits: makeTraits(rng) });
}

/**
 * A homogeneous 12-person club of one archetype — deliberately the hardest
 * case for a global cohort, because everyone in it looks alike and the
 * discrimination has to come from within-group spread.
 */
const clubIdx = roster
  .map((p, i) => [p, i])
  .filter(([p]) => p.a === "efficient_daily")
  .slice(0, CLUB_SIZE)
  .map(([, i]) => i);

const rankOrder = (values) =>
  values
    .map((v, i) => [v, i])
    .sort((x, y) => y[0] - x[0])
    .map(([, i]) => i);

let agree = 0;
let total = 0;

for (let day = 0; day < DAYS; day++) {
  const metrics = roster.map((p) => getArchetype(p.a).day({ day, rng }, p.traits));
  const sigs = metrics.map(rawSignals);

  // (a) Global cohort z — what `#6` requires and what ships.
  const globalZ = zScores(sigs);
  const globalPts = clubIdx.map((i) => dailyScore(metrics[i], globalZ[i], STREAK_DAYS).points);

  // (b) Arena-local cohort z — what `#4.2` asked for.
  const localZ = zScores(clubIdx.map((i) => sigs[i]));
  const localPts = clubIdx.map((i, k) => dailyScore(metrics[i], localZ[k], STREAK_DAYS).points);

  const global = rankOrder(globalPts);
  const local = rankOrder(localPts);
  for (let k = 0; k < global.length; k++) {
    total++;
    if (global[k] === local[k]) agree++;
  }
}

const pct = (agree / total) * 100;
console.log(
  `within-club ordering identical under global vs arena-local z: ` +
    `${pct.toFixed(1)}% of positions (${agree}/${total} over ${DAYS} days)`,
);
console.log(`  random baseline for ${CLUB_SIZE} positions: ~${(100 / CLUB_SIZE).toFixed(1)}%`);
console.log(
  pct > 90
    ? `  -> effectively equivalent; #6's choice is free`
    : `  -> NOT equivalent. #6's write-path saving costs real discrimination\n` +
        `     inside small cohorts. Revisiting means a per-arena rating table,\n` +
        `     not a weight tweak.`,
);

// ── The fairness worry `#4.2` actually voiced ──────────────────────────────
const rng2 = makeRng(777);
const traits = { scale: 1, diligence: 0.5 };
const solo = getArchetype("efficient_daily").day({ day: 0, rng: rng2 }, traits);
const whale = getArchetype("whale_burner").day({ day: 0, rng: rng2 }, traits);
const [zSolo, zWhale] = zScores([rawSignals(solo), rawSignals(whale)]);
const s = dailyScore(solo, zSolo, STREAK_DAYS);
const w = dailyScore(whale, zWhale, STREAK_DAYS);

console.log(`\n\`volume_pts\` is absolute, NOT cohort-relative:`);
console.log(`  hobbyist    volume_pts=${s.volumePts.toFixed(1)}  effMult=${s.efficiencyMult.toFixed(2)}`);
console.log(`  team/whale  volume_pts=${w.volumePts.toFixed(1)}  effMult=${w.efficiencyMult.toFixed(2)}`);
console.log(
  `  -> the volume gap (${(w.volumePts - s.volumePts).toFixed(1)} pts) is unaffected by\n` +
    `     which cohort you z-score against, so "a hobbyist scored against a\n` +
    `     monorepo team" is a worry about the multiplier only.`,
);
