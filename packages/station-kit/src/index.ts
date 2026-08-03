import type { StationUserConfig } from "./config/schema.js";

export function defineConfig(config: StationUserConfig): StationUserConfig {
  return config;
}

export type {
  StationConfig,
  StationUserConfig,
  AuthConfig,
  DeployConfig,
  SubscribersConfig,
} from "./config/schema.js";
export { resolveConfig } from "./config/schema.js";
export { loadConfig } from "./config/loader.js";

// Re-export the runtime env store surface so consumers can construct custom
// storage or the store itself without a separate `station-env` import.
export {
  EnvStore,
  MemoryEnvStorage,
  FileEnvStorage,
  type EnvStorageAdapter,
  type EnvVar,
  type EnvVarPublic,
  type EnvTarget,
} from "station-env";
