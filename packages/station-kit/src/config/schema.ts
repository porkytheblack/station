import type { SignalQueueAdapter } from "station-signal";
import type { BroadcastQueueAdapter } from "station-broadcast";
import type { BeaconStateAdapter } from "station-beacon";
import type { ScheduleAdapter } from "station-schedules";
import type { EnvStorageAdapter } from "station-env";
import type { ApiKeyStorageAdapter } from "../server/auth/keys.js";
import type { LogStorageAdapter } from "../server/log-store.js";

export interface AuthConfig {
  username: string;
  password: string;
  sessionTtlMs?: number;
  /**
   * Pluggable storage backend for API keys. Defaults to a JSON file at
   * `<dataDir>/station-keys.json` (no native dependencies required).
   * Provide a custom adapter to host keys in SQLite, Postgres, MySQL,
   * Redis, etc.
   */
  keyStorage?: ApiKeyStorageAdapter;
}

export interface RunnerConfig {
  pollIntervalMs: number;
  maxConcurrent: number;
  maxAttempts: number;
  retryBackoffMs: number;
}

export interface BroadcastRunnerConfig {
  pollIntervalMs: number;
}

export interface DeployConfig {
  include?: string[];
}

export interface StationConfig {
  port: number;
  host: string;
  adapter?: SignalQueueAdapter;
  broadcastAdapter?: BroadcastQueueAdapter;
  /**
   * Optional beacon supervision-state adapter. When provided (or when
   * `beaconsDir` is set), the dashboard supervises long-running beacons and
   * exposes them under `/api/beacons`.
   */
  beaconAdapter?: BeaconStateAdapter;
  /**
   * Default cap on how many instances of one beacon may exist at once, applied
   * to beacons that don't declare their own `.maxInstances()`. Bounds how many
   * processes an API caller can spawn by creating instances. @default 100
   */
  beaconMaxInstances?: number;
  /**
   * Optional schedule storage adapter. When provided, runtime-editable
   * schedules are persisted here and reconciled by both runners.
   */
  scheduleAdapter?: ScheduleAdapter;
  /**
   * Pluggable storage backend for runtime environment variables. Defaults to a
   * JSON file at `<dataDir>/station-env.json` (no native dependencies). When
   * set — or by default — signals/beacons can require env vars via `.env()`,
   * and variables defined here (globally or scoped to specific targets) are
   * injected into runs. For multi-process deployments pass a durable adapter
   * from a `station-adapter-*` package's `/env` subpath.
   */
  envStorage?: EnvStorageAdapter;
  /**
   * Pluggable storage backend for run logs. Defaults to a `FileLogStorage`
   * (append-only JSONL file at `<dataDir>/station-logs.jsonl`, no native
   * dependencies). The default is single-process only — for multi-process
   * deployments or guaranteed durability, implement `LogStorageAdapter`
   * against Postgres, MySQL, Redis, S3, etc., and pass it here.
   */
  logStorage?: LogStorageAdapter;
  signalsDir?: string;
  broadcastsDir?: string;
  beaconsDir?: string;
  stationDir: string;
  runner: RunnerConfig;
  broadcastRunner: BroadcastRunnerConfig;
  runRunners: boolean;
  open: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
  auth?: AuthConfig;
  deploy?: DeployConfig;
}

export type StationUserConfig = Partial<Omit<StationConfig, "runner" | "broadcastRunner">> & {
  runner?: Partial<RunnerConfig>;
  broadcastRunner?: Partial<BroadcastRunnerConfig>;
};

const DEFAULTS: StationConfig = {
  port: 4400,
  host: "localhost",
  stationDir: ".station",
  runner: {
    pollIntervalMs: 1000,
    maxConcurrent: 5,
    maxAttempts: 1,
    retryBackoffMs: 1000,
  },
  broadcastRunner: {
    pollIntervalMs: 1000,
  },
  runRunners: true,
  open: true,
  logLevel: "info",
};

export function resolveConfig(input: StationUserConfig): StationConfig {
  const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
  const envHost = process.env.HOST;
  const envAuthUser = process.env.STATION_AUTH_USERNAME;
  const envAuthPass = process.env.STATION_AUTH_PASSWORD;

  // Env vars for auth: override config values, or create auth if both are set
  let auth = input.auth;
  if (auth) {
    auth = {
      ...auth,
      username: envAuthUser ?? auth.username,
      password: envAuthPass ?? auth.password,
    };
  } else if (envAuthUser && envAuthPass) {
    auth = { username: envAuthUser, password: envAuthPass };
  }

  return {
    port: input.port ?? envPort ?? DEFAULTS.port,
    host: input.host ?? envHost ?? DEFAULTS.host,
    adapter: input.adapter,
    broadcastAdapter: input.broadcastAdapter,
    beaconAdapter: input.beaconAdapter,
    beaconMaxInstances: input.beaconMaxInstances,
    scheduleAdapter: input.scheduleAdapter,
    envStorage: input.envStorage,
    logStorage: input.logStorage,
    signalsDir: input.signalsDir,
    broadcastsDir: input.broadcastsDir,
    beaconsDir: input.beaconsDir,
    stationDir: input.stationDir ?? DEFAULTS.stationDir,
    runner: {
      pollIntervalMs: input.runner?.pollIntervalMs ?? DEFAULTS.runner.pollIntervalMs,
      maxConcurrent: input.runner?.maxConcurrent ?? DEFAULTS.runner.maxConcurrent,
      maxAttempts: input.runner?.maxAttempts ?? DEFAULTS.runner.maxAttempts,
      retryBackoffMs: input.runner?.retryBackoffMs ?? DEFAULTS.runner.retryBackoffMs,
    },
    broadcastRunner: {
      pollIntervalMs: input.broadcastRunner?.pollIntervalMs ?? DEFAULTS.broadcastRunner.pollIntervalMs,
    },
    runRunners: input.runRunners ?? DEFAULTS.runRunners,
    open: input.open ?? DEFAULTS.open,
    logLevel: input.logLevel ?? DEFAULTS.logLevel,
    auth,
    deploy: input.deploy,
  };
}
