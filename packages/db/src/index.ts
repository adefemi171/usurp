export * as schema from "./schema.js";
export { saveOwnedBridge, mergeBridgeSeries } from "./bridge.js";
export {
  achievements,
  arenaMembers,
  arenas,
  dailyScores,
  deviceEnrollments,
  devices,
  duels,
  events,
  identities,
  notificationChannels,
  notificationDeliveries,
  reigns,
  seasons,
  sessions,
  standings,
  usageEvents,
  userAchievements,
  users,
  type Arena,
  type ArenaMember,
  type Device,
  type UsageEvent,
  type User,
} from "./schema.js";

export { closeDb, connectionString, getDb, getSql, type Db } from "./client.js";

export {
  ingest,
  findDeviceByPublicKey,
  type IngestFailure,
  type IngestOptions,
  type IngestRejection,
  type IngestResult,
} from "./ingest.js";

export {
  ENROLLMENT_TTL_MS,
  formatCode,
  issueEnrollment,
  newDeviceId,
  normalizeCode,
  pruneEnrollments,
  redeemEnrollment,
  safeEqual,
  upsertUserByHandle,
  type IssuedEnrollment,
  type RedeemFailure,
  type RedeemResult,
} from "./enrollment.js";

export { GLOBAL_ARENA_SLUG, joinGlobalArena, seedGlobalArena } from "./seed.js";

export {
  burnBoard,
  pseudonymFor,
  windowStart,
  type BoardWindow,
  type BurnBoard,
  type BurnBoardOptions,
  type BurnRow,
} from "./board.js";

export {
  derivedSignals,
  userProfile,
  type AgentBreakdown,
  type DayBreakdown,
  type ModelBreakdown,
  type Profile,
  type ProfileOptions,
  type ProfileTotals,
  type UsageSeriesPoint,
} from "./profile.js";

export {
  HANDLE_MAX,
  HANDLE_MIN,
  SESSION_REFRESH_AFTER_MS,
  SESSION_TTL_MS,
  claimHandle,
  createSession,
  deriveHandle,
  destroyAllSessions,
  destroySession,
  emailDomainOf,
  optInToGlobal,
  pruneSessions,
  resolveSession,
  safeCompare,
  signInWithOAuth,
  validateHandle,
  validateHandleShape,
  type ClaimHandleResult,
  type HandleRejection,
  type IssuedSession,
  type OAuthProfile,
  type SessionUser,
  type SignInResult,
} from "./auth.js";

export {
  CLUB_MAX_MEMBERS,
  MAX_OWNED_CLUBS,
  NAME_MAX,
  NAME_MIN,
  createClub,
  defaultVisibilityFor,
  joinByInviteCode,
  leaveArena,
  membershipsFor,
  normalizeInviteCode,
  rotateInviteCode,
  setVisibility,
  type CreateClubFailure,
  type CreateClubResult,
  type JoinFailure,
  type JoinResult,
  type Membership,
  type VisibilityFailure,
} from "./arenas.js";

export {
  SEASON_LENGTH_DAYS,
  addDays,
  closeElapsedSeasons,
  ensureCurrentSeason,
  ensureSeasonsForArenas,
  seasonDays,
  startOfUtcDay,
  type Season,
} from "./seasons.js";

export {
  EVENT_CROWNED,
  EVENT_USURPED,
  TITLES,
  crownedCopy,
  formatDuration,
  titleForRank,
  usurpedCopy,
  type BoardTitle,
  type TitleCopy,
} from "./titles.js";

export {
  STREAK_LOOKBACK_DAYS,
  dailyMetrics,
  recomputeDailyScores,
  recomputeStandings,
  ratingBoard,
  seasonStandings,
  type RecomputeDailyResult,
  type RecomputeStandingsResult,
  type RatingBoard,
  type StandingRow,
} from "./rating.js";

export {
  DELIVERY_RETENTION_MS,
  DISPATCH_LOOKBACK_MS,
  NOTIFIABLE,
  THRONE_COOLDOWN_MS,
  THROTTLED,
  addChannel,
  buildPayload,
  channelsFor,
  dispatchNotifications,
  httpTransport,
  pruneDeliveries,
  removeChannel,
  revealChannelSecret,
  setChannelEnabled,
  signBody,
  validateTarget,
  type AddChannelResult,
  type Channel,
  type ChannelKind,
  type ChannelView,
  type DispatchSummary,
  type NotificationPayload,
  type SendResult,
  type Transport,
} from "./notifications.js";

export {
  arenaFeed,
  arenaVisibility,
  currentSovereign,
  longestReigns,
  resolveActor,
  type ArenaFeed,
  type FeedActor,
  type FeedEntry,
  type FeedOptions,
  type ReignRecord,
} from "./feed.js";

export {
  QUEUE_MAINTENANCE,
  QUEUE_RECOMPUTE,
  RECOMPUTE_WINDOW_DAYS,
  runMaintenance,
  runRecompute,
  startWorker,
  type MaintenanceSummary,
  type RecomputeSummary,
  type Worker,
  type WorkerOptions,
} from "./jobs.js";

export {
  accountCount,
  arenaStats,
  platformStats,
  type ArenaStats,
  type PlatformStats,
} from "./stats.js";

export {
  CUT_FRACTION,
  FINAL_CIRCLE_SIZE,
  MIN_MEMBERS_FOR_CIRCLES,
  activeMemberCount,
  applyCircles,
  attachSchedule,
  circleScheduleFor,
  readSchedule,
  survivorsAfter,
  type CircleCut,
  type CircleResult,
  type CircleSchedule,
} from "./circles.js";

export {
  DUEL_METRICS,
  DUEL_WINDOWS,
  EVENT_DUEL_ACCEPTED,
  EVENT_DUEL_DECLINED,
  EVENT_DUEL_PROPOSED,
  EVENT_DUEL_SETTLED,
  MAX_CONCURRENT_DUELS,
  MAX_WAGER,
  MIN_WAGER,
  PROPOSAL_TTL_HOURS,
  acceptDuel,
  declineDuel,
  duelScores,
  duelsForUser,
  proposeDuel,
  settleDuels,
  type Duel,
  type DuelMetric,
  type DuelView,
  type DuelWindow,
  type ProposeFailure,
  type ProposeInput,
  type ProposeResult,
  type RespondFailure,
  type RespondResult,
  type SettledDuel,
} from "./duels.js";
