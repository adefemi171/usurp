export {
  SIGNAL_NAMES,
  Z_CLAMP,
  clampZ,
  effectiveTokens,
  rawSignals,
  zScores,
  type DailyMetrics,
  type RawSignals,
  type SignalName,
  type SignalZScores,
} from "./signals.js";

export {
  DECAY_PER_INACTIVE_DAY,
  DEFAULT_WEIGHTS,
  EFFICIENCY_MAX,
  EFFICIENCY_MIN,
  STREAK_MAX,
  STREAK_STEP,
  advanceDay,
  dailyScore,
  efficiencyMultiplier,
  isActive,
  newSeasonState,
  scoreCohortDay,
  streakMultiplier,
  volumePoints,
  type DailyScore,
  type SeasonState,
  type Weights,
} from "./score.js";

export {
  ARCHETYPE_NAMES,
  allArchetypes,
  getArchetype,
  idleDay,
  makeRng,
  makeTraits,
  type Archetype,
  type ArchetypeName,
  type DayContext,
  type PlayerTraits,
} from "./archetypes.js";

export {
  DEFAULT_PLAYERS,
  DEFAULT_SEASONS,
  SEASON_DAYS,
  simulate,
  type ArchetypeSummary,
  type PlayerResult,
  type SimulationOptions,
  type SimulationResult,
} from "./simulate.js";

export {
  GAMER_MAX_PERCENTILE,
  INTENDED_MEDIAN_MAX_PERCENTILE,
  INTENDED_MIN_SHARE_OF_TOP_10,
  WHALE_MAX_PERCENTILE,
  evaluateGate,
  formatGateReport,
  type GateCheck,
  type GateResult,
} from "./gate.js";

export {
  DEFAULT_GRID,
  formatTuningReport,
  tuneWeights,
  type Candidate,
  type TuningOptions,
  type TuningResult,
} from "./tune.js";
