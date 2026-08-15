import type { SignalQueueAdapter, SignalSubscriber } from "station-signal";
import type { BroadcastQueueAdapter, BroadcastSubscriber } from "station-broadcast";
import type { BeaconStateAdapter, BeaconSubscriber } from "station-beacon";
import type { ScheduleAdapter } from "station-schedules";
import type { EnvStorageAdapter } from "station-env";
import type { ApiKeyStorageAdapter } from "../server/auth/keys.js";
import type { LogStorageAdapter } from "../server/log-store.js";
import type { StationNetworkAdapter, StationRole } from "station-network";

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

export interface StationNetworkConfig {
  /** Logical network/fleet name. @default "default" */
  id?: string;
  /** Stable node identity. Defaults to STATION_ID or a generated process identity. */
  stationId?: string;
  /** Human-readable node name. Defaults to stationId. */
  name?: string;
  /** Durable membership/leader-lease backend. Memory is only suitable for standalone mode. */
  adapter?: StationNetworkAdapter;
  /** Labels used by placement policies, for example `{ region: "ke", gpu: "true" }`. */
  labels?: Record<string, string>;
  /** Public or tunnel endpoint advertised to Headquarters. */
  endpoint?: string;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
}

/**
 * Your own lifecycle subscribers, registered alongside the ones Station wires
 * for the dashboard and event stream. Use them for metrics, alerting, audit
 * logs, or any cross-cutting side effect that shouldn't live inside a handler.
 *
 * Station's internal subscribers are always registered and always run first —
 * these are additive, so a slow or throwing subscriber of yours can't stop the
 * dashboard from updating. Errors thrown from a subscriber are caught and
 * logged by the runner, never propagated into a run.
 */
export interface SubscribersConfig {
  /** Signal run lifecycle: dispatched, started, completed, failed, retried, steps, logs. */
  signal?: SignalSubscriber[];
  /** Broadcast lifecycle: queued, started, completed, failed, and per-node events. */
  broadcast?: BroadcastSubscriber[];
  /** Beacon supervision: starting, ready, heartbeat, exited, restart-scheduled, instance create/remove. */
  beacon?: BeaconSubscriber[];
}

export interface StationConfig {
  role: StationRole;
  network: Required<Pick<StationNetworkConfig, "id" | "stationId" | "name" | "labels" | "heartbeatIntervalMs" | "leaseDurationMs">> &
    Omit<StationNetworkConfig, "id" | "stationId" | "name" | "labels" | "heartbeatIntervalMs" | "leaseDurationMs">;
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
  /**
   * Your own lifecycle subscribers for metrics, alerting, or audit logging.
   * Registered in addition to Station's own — see {@link SubscribersConfig}.
   * Only applied when `runRunners` is true, since there are no runners to
   * subscribe to otherwise.
   */
  subscribers?: SubscribersConfig;
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

export type StationUserConfig = Partial<Omit<StationConfig, "runner" | "broadcastRunner" | "network">> & {
  runner?: Partial<RunnerConfig>;
  broadcastRunner?: Partial<BroadcastRunnerConfig>;
  network?: StationNetworkConfig;
};

const DEFAULTS: StationConfig = {
  role: "standalone",
  network: {
    id: "default",
    stationId: "",
    name: "",
    labels: {},
    heartbeatIntervalMs: 5_000,
    leaseDurationMs: 15_000,
  },
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

  const role = input.role ?? DEFAULTS.role;
  const stationId = input.network?.stationId ?? process.env.STATION_ID ?? `station-${process.pid}`;

  return {
    role,
    network: {
      id: input.network?.id ?? process.env.STATION_NETWORK_ID ?? DEFAULTS.network.id,
      stationId,
      name: input.network?.name ?? process.env.STATION_NAME ?? stationId,
      adapter: input.network?.adapter,
      labels: input.network?.labels ?? {},
      endpoint: input.network?.endpoint,
      heartbeatIntervalMs: input.network?.heartbeatIntervalMs ?? DEFAULTS.network.heartbeatIntervalMs,
      leaseDurationMs: Math.max(
        input.network?.leaseDurationMs ?? DEFAULTS.network.leaseDurationMs,
        (input.network?.heartbeatIntervalMs ?? DEFAULTS.network.heartbeatIntervalMs) * 2,
      ),
    },
    port: input.port ?? envPort ?? DEFAULTS.port,
    host: input.host ?? envHost ?? DEFAULTS.host,
    adapter: input.adapter,
    broadcastAdapter: input.broadcastAdapter,
    beaconAdapter: input.beaconAdapter,
    beaconMaxInstances: input.beaconMaxInstances,
    scheduleAdapter: input.scheduleAdapter,
    envStorage: input.envStorage,
    logStorage: input.logStorage,
    subscribers: input.subscribers,
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
    runRunners: input.runRunners ?? (role !== "headquarters"),
    open: input.open ?? DEFAULTS.open,
    logLevel: input.logLevel ?? DEFAULTS.logLevel,
    auth,
    deploy: input.deploy,
  };
}
