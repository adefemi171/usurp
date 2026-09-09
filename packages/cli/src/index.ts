/** Programmatic surface, for tests and for embedding the sync in another tool. */

export { loadConfig, saveConfig, updateConfig, configPath, configDir, DEFAULT_API_URL, type Config } from "./config.js";
export {
  deleteKey,
  describeSource,
  keychainAvailable,
  loadKey,
  saveKey,
  KeystoreError,
  type KeySource,
  type ResolvedKey,
} from "./keystore.js";
export { ApiClient, type ApiResult, type IngestOk, type RegisterOk } from "./api.js";
export {
  collect,
  resolveSince,
  summarize,
  FIRST_SYNC_LOOKBACK_MS,
  MAX_LOOKBACK_MS,
  SYNC_OVERLAP_MS,
  type Collected,
  type CollectOptions,
} from "./collect.js";
export { login, logout } from "./commands/login.js";
export { preview } from "./commands/preview.js";
export { status } from "./commands/status.js";
export { sync } from "./commands/sync.js";
export { claudeSettingsPath, hookInstall, hookStatus, hookUninstall } from "./commands/hook.js";
