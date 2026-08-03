import { z, parseInterval } from "station-signal";
import { type BeaconContext, type BeaconHandler, sleepOrAbort } from "./context.js";
import { BeaconDefinitionError } from "./errors.js";
import {
  type BackoffConfig,
  DEFAULT_BACKOFF,
  DEFAULT_STOP_TIMEOUT_MS,
  type RestartPolicy,
  type StartMode,
} from "./types.js";
import { BEACON_BRAND } from "./util.js";

const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Accept either an interval string ("1s", "30s", "5m") or a raw millisecond count. */
function toMs(value: string | number): number {
  return typeof value === "number" ? value : parseInterval(value);
}

/** Options accepted by `.backoff(base, opts)`. */
export interface BackoffOptions {
  /** Multiplier applied per consecutive restart. @default 2 */
  factor?: number;
  /** Upper bound on any single restart delay. @default "30s" */
  max?: string | number;
  /** Uptime after which the consecutive-restart counter resets. @default "60s" */
  resetAfter?: string | number;
}

/** Options accepted by `.heartbeat(interval, opts)`. */
export interface HeartbeatOptions {
  /**
   * Max gap between heartbeats before the supervisor considers the process
   * stalled and restarts it. @default 3× the declared interval
   */
  timeout?: string | number;
}

/**
 * A fully-built beacon definition. Discovered from a beacons directory (or
 * registered explicitly) and supervised by a {@link BeaconRunner}. Unlike a
 * signal, a beacon isn't "triggered" — it's started and stopped by the runner,
 * which keeps it alive according to its restart policy.
 */
export interface Beacon<TConfig = unknown> {
  readonly [BEACON_BRAND]: true;
  readonly name: string;
  readonly configSchema: z.ZodType<TConfig>;
  readonly defaultConfig?: TConfig;
  /** The long-running body. For `.poll()` beacons this is the generated loop. */
  readonly handler: BeaconHandler<TConfig>;
  /** `"run"` for a raw long-running handler, `"poll"` for an interval loop. */
  readonly mode: "run" | "poll";
  /** Poll cadence in ms (poll mode only). */
  readonly pollIntervalMs?: number;
  readonly restartPolicy: RestartPolicy;
  readonly backoff: BackoffConfig;
  /** Grace period after SIGTERM before the process is force-killed. */
  readonly stopTimeoutMs: number;
  /**
   * Max time in ms from spawn for the beacon to reach ready (`ctx.ready()`).
   * If exceeded, the supervisor kills and restarts it (per policy). Presence
   * enables startup-timeout detection; requires the beacon to call `ctx.ready()`.
   */
  readonly startupTimeoutMs?: number;
  /** Declared heartbeat cadence in ms — presence enables stall detection. */
  readonly heartbeatIntervalMs?: number;
  /** Deadline in ms after which a missed heartbeat is treated as a stall. */
  readonly heartbeatTimeoutMs?: number;
  /**
   * How instances of this beacon come into existence: seeded and started on
   * discovery (`auto`), seeded but left stopped (`manual`), or created only at
   * runtime through the API (`on-demand`).
   */
  readonly startMode: StartMode;
  /**
   * Whether the supervisor starts this beacon automatically on discovery.
   * Equivalent to `startMode === "auto"`.
   */
  readonly autoStart: boolean;
  /**
   * Cap on how many instances of this beacon may exist at once. Unset means the
   * supervisor's own `maxInstancesPerBeacon` limit applies.
   */
  readonly maxInstances?: number;
  /** Env var keys that must be present (store-managed or process env) for the beacon to launch. */
  readonly requiredEnv?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBeacon = Beacon<any>;

interface BuilderOpts<TConfig> {
  configSchema?: z.ZodType<TConfig>;
  defaultConfig?: TConfig;
  restartPolicy: RestartPolicy;
  backoff: BackoffConfig;
  stopTimeoutMs: number;
  startupTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  startMode: StartMode;
  maxInstances?: number;
  requiredEnv?: string[];
}

/**
 * Immutable builder for a beacon. Every method returns a fresh builder, so
 * branching off a shared builder never mutates the original (same discipline
 * as the signal builder).
 */
export class BeaconBuilder<TConfig = Record<string, never>> {
  private readonly _name: string;
  private readonly _opts: BuilderOpts<TConfig>;

  constructor(name: string, opts?: BuilderOpts<TConfig>) {
    if (!VALID_NAME.test(name)) {
      throw new Error(
        `Invalid beacon name "${name}". Names must start with a letter and contain only letters, digits, hyphens, and underscores.`,
      );
    }
    this._name = name;
    this._opts = opts ?? {
      restartPolicy: "on-failure",
      backoff: { ...DEFAULT_BACKOFF },
      stopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
      startMode: "auto",
    };
  }

  private _clone(overrides: Partial<BuilderOpts<TConfig>>): BeaconBuilder<TConfig> {
    return new BeaconBuilder<TConfig>(this._name, { ...this._opts, ...overrides });
  }

  /** Declare the config schema. Config is validated (with defaults applied) before each start. */
  config<T>(schema: z.ZodType<T>): BeaconBuilder<T> {
    return new BeaconBuilder<T>(this._name, {
      ...(this._opts as unknown as BuilderOpts<T>),
      configSchema: schema,
      defaultConfig: undefined,
    });
  }

  /** Set the default config used when the beacon is started without an explicit override. */
  withConfig(config: TConfig): BeaconBuilder<TConfig> {
    return this._clone({ defaultConfig: config });
  }

  /** How the supervisor reacts when the process exits. @default "on-failure" */
  restart(policy: RestartPolicy): BeaconBuilder<TConfig> {
    return this._clone({ restartPolicy: policy });
  }

  /** Configure exponential restart backoff. `base` is the first-restart delay. */
  backoff(base: string | number, opts: BackoffOptions = {}): BeaconBuilder<TConfig> {
    const baseMs = toMs(base);
    const backoff: BackoffConfig = {
      baseMs,
      factor: opts.factor ?? DEFAULT_BACKOFF.factor,
      maxMs: opts.max !== undefined ? toMs(opts.max) : Math.max(baseMs, DEFAULT_BACKOFF.maxMs),
      resetAfterMs: opts.resetAfter !== undefined ? toMs(opts.resetAfter) : DEFAULT_BACKOFF.resetAfterMs,
    };
    if (backoff.factor < 1) {
      throw new BeaconDefinitionError(this._name, "backoff factor must be >= 1");
    }
    return this._clone({ backoff });
  }

  /**
   * Opt into heartbeat-based stall detection. The handler must call
   * `ctx.heartbeat()` at least every `interval`; if the supervisor sees no
   * heartbeat within the timeout (default 3× interval) it restarts the process.
   */
  heartbeat(interval: string | number, opts: HeartbeatOptions = {}): BeaconBuilder<TConfig> {
    const heartbeatIntervalMs = toMs(interval);
    const heartbeatTimeoutMs =
      opts.timeout !== undefined ? toMs(opts.timeout) : heartbeatIntervalMs * 3;
    if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
      throw new BeaconDefinitionError(
        this._name,
        "heartbeat timeout must be greater than the heartbeat interval",
      );
    }
    return this._clone({ heartbeatIntervalMs, heartbeatTimeoutMs });
  }

  /** Grace period a stopping beacon gets before it is force-killed. @default "10s" */
  stopTimeout(value: string | number): BeaconBuilder<TConfig> {
    return this._clone({ stopTimeoutMs: toMs(value) });
  }

  /**
   * Deadline (from spawn) for the beacon to reach ready via `ctx.ready()`. If it
   * doesn't, the supervisor kills and restarts it (per policy) — catching boot
   * hangs (a wedged import) and "started but never came up" handlers. Requires
   * the beacon to call `ctx.ready()`; off by default.
   */
  startupTimeout(value: string | number): BeaconBuilder<TConfig> {
    return this._clone({ startupTimeoutMs: toMs(value) });
  }

  /**
   * Set how instances of this beacon come into existence. `.manualStart()` and
   * `.onDemand()` are the named shorthands for the two non-default modes.
   */
  startMode(mode: StartMode): BeaconBuilder<TConfig> {
    return this._clone({ startMode: mode });
  }

  /** Don't auto-start on discovery — the beacon stays stopped until started explicitly. */
  manualStart(): BeaconBuilder<TConfig> {
    return this._clone({ startMode: "manual" });
  }

  /**
   * Run only instances created at runtime. Nothing is seeded on discovery;
   * callers create instances through the API (or `runner.createInstance()`),
   * each with its own config, and delete them when they're done. Use this for
   * beacons that are parameterised per tenant / stream / job rather than being
   * a single always-on process.
   */
  onDemand(): BeaconBuilder<TConfig> {
    return this._clone({ startMode: "on-demand" });
  }

  /**
   * Cap how many instances of this beacon may exist at once — the guardrail on
   * an API that can spawn processes. Defaults to the supervisor's
   * `maxInstancesPerBeacon`.
   */
  maxInstances(limit: number): BeaconBuilder<TConfig> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new BeaconDefinitionError(this._name, "maxInstances must be a positive integer");
    }
    return this._clone({ maxInstances: limit });
  }

  /**
   * Declare env vars this beacon needs. Before each launch, the supervisor
   * verifies each key is available — from its env provider (the Station env
   * store) or the host process env — and marks the beacon `errored` instead
   * of spawning when any is missing. Provided vars are injected into the
   * child process env, so handlers read them via `process.env.KEY` as usual.
   */
  env(...keys: string[]): BeaconBuilder<TConfig> {
    for (const key of keys) {
      if (!VALID_ENV_KEY.test(key)) {
        throw new BeaconDefinitionError(
          this._name,
          `invalid env key "${key}" — keys must start with a letter or underscore and contain only letters, digits, and underscores`,
        );
      }
    }
    const merged = [...(this._opts.requiredEnv ?? []), ...keys];
    return this._clone({ requiredEnv: Array.from(new Set(merged)) });
  }

  private _finalize(
    mode: "run" | "poll",
    handler: BeaconHandler<TConfig>,
    pollIntervalMs?: number,
  ): Beacon<TConfig> {
    const schema =
      this._opts.configSchema ?? (z.object({}) as unknown as z.ZodType<TConfig>);
    return {
      [BEACON_BRAND]: true as const,
      name: this._name,
      configSchema: schema,
      defaultConfig: this._opts.defaultConfig,
      handler,
      mode,
      pollIntervalMs,
      restartPolicy: this._opts.restartPolicy,
      backoff: this._opts.backoff,
      stopTimeoutMs: this._opts.stopTimeoutMs,
      startupTimeoutMs: this._opts.startupTimeoutMs,
      heartbeatIntervalMs: this._opts.heartbeatIntervalMs,
      heartbeatTimeoutMs: this._opts.heartbeatTimeoutMs,
      startMode: this._opts.startMode,
      autoStart: this._opts.startMode === "auto",
      maxInstances: this._opts.maxInstances,
      requiredEnv: this._opts.requiredEnv,
    };
  }

  /**
   * Finalize with a long-running handler. The handler runs until it returns,
   * throws, or `ctx.signal` aborts. Use it for servers and stream clients.
   */
  run(handler: BeaconHandler<TConfig>): Beacon<TConfig> {
    return this._finalize("run", handler);
  }

  /**
   * Finalize as a poller: the framework calls `fn` every `interval` until the
   * beacon is stopped, marking the beacon ready on the first tick. Throwing
   * from `fn` crashes the incarnation and lets the restart policy take over;
   * catch inside `fn` to keep polling through transient errors.
   */
  poll(interval: string | number, fn: BeaconHandler<TConfig>): Beacon<TConfig> {
    const intervalMs = toMs(interval);
    const loop: BeaconHandler<TConfig> = async (ctx: BeaconContext<TConfig>) => {
      ctx.ready();
      while (!ctx.signal.aborted) {
        await fn(ctx);
        if (ctx.signal.aborted) break;
        await sleepOrAbort(intervalMs, ctx.signal);
      }
    };
    return this._finalize("poll", loop, intervalMs);
  }
}

/** Start defining a beacon. */
export function beacon(name: string): BeaconBuilder {
  return new BeaconBuilder(name);
}
