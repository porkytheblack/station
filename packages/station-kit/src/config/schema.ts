import type { SignalQueueAdapter } from "station-signal";
import type { BroadcastQueueAdapter } from "station-broadcast";

export interface AuthConfig {
  username: string;
  password: string;
  sessionTtlMs?: number;
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
  signalsDir?: string;
  broadcastsDir?: string;
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
    signalsDir: input.signalsDir,
    broadcastsDir: input.broadcastsDir,
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
