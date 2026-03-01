import type { StationUserConfig } from "./config/schema.js";

export function defineConfig(config: StationUserConfig): StationUserConfig {
  return config;
}

export type { StationConfig, StationUserConfig, AuthConfig } from "./config/schema.js";
