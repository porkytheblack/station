import { z, parseInterval } from "station-signal";
import { type BeaconContext, type BeaconHandler, sleepOrAbort } from "./context.js";
import { BeaconDefinitionError } from "./errors.js";
import {
  type BackoffConfig,
  DEFAULT_BACKOFF,
  DEFAULT_STOP_TIMEOUT_MS,
  type RestartPolicy,
} from "./types.js";
import { BEACON_BRAND } from "./util.js";

const VALID_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

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
  /** Declared heartbeat cadence in ms — presence enables stall detection. */
  readonly heartbeatIntervalMs?: number;
  /** Deadline in ms after which a missed heartbeat is treated as a stall. */
  readonly heartbeatTimeoutMs?: number;
  /** Whether the supervisor starts this beacon automatically on discovery. */
  readonly autoStart: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBeacon = Beacon<any>;

interface BuilderOpts<TConfig> {
  configSchema?: z.ZodType<TConfig>;
  defaultConfig?: TConfig;
  restartPolicy: RestartPolicy;
  backoff: BackoffConfig;
  stopTimeoutMs: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  autoStart: boolean;
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
      autoStart: true,
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

  /** Don't auto-start on discovery — the beacon stays stopped until started explicitly. */
  manualStart(): BeaconBuilder<TConfig> {
    return this._clone({ autoStart: false });
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
      heartbeatIntervalMs: this._opts.heartbeatIntervalMs,
      heartbeatTimeoutMs: this._opts.heartbeatTimeoutMs,
      autoStart: this._opts.autoStart,
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
