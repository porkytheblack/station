import type { StationUserConfig } from "./config/schema.js";
export { FileImageDeploymentStorage, type ImageDeploymentStorage, type DeploymentSnapshot, type ImageDeployment, type DeploymentGeneration } from './images/deployments.js';
export type { TenantImageRegistryConfig, TenantRegistryNamespace, TenantRegistryGrant, TenantRegistryExecution, TenantImageRunTarget, RegistryPermission } from './registry/tenants.js';
export type { ImageArtifactPolicy } from './images/shim.js';
export type { NativeSignalGrant } from './images/native-signal.js';
export type { BeaconRollout } from './images/deployments.js';
export type { RegistryTargets } from './registry/proxy.js';
export { createTenantRegistryWorkerGateway, type TenantRegistryWorkerGatewayOptions } from './registry/worker-gateway.js';

export function defineConfig(config: StationUserConfig): StationUserConfig {
  return config;
}

export type {
  StationConfig,
  StationUserConfig,
  AuthConfig,
  ExecutionConfig,
  DeployConfig,
  SubscribersConfig,
  StationNetworkConfig,
} from "./config/schema.js";
export type { StationRole, StationNode, StationNetworkAdapter } from "station-network";
export { StationNetworkMemoryAdapter } from "station-network";
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
