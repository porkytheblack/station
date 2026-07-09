/**
 * The context object passed to every beacon handler. It is the beacon's window
 * into the supervisor: how it learns it should stop, and how it reports that it
 * is alive and healthy.
 */
export interface BeaconContext<TConfig = unknown> {
  /** The beacon's name. */
  readonly name: string;
  /** Validated configuration for this incarnation (schema defaults applied). */
  readonly config: TConfig;
  /**
   * Which incarnation this is (1 for the first start, incremented on each
   * supervised restart). Useful for logging and connection labels.
   */
  readonly incarnation: number;
  /**
   * Aborts when the supervisor wants the beacon to stop — a graceful shutdown,
   * a `desired=stopped` transition, or a heartbeat-stall kill. Long-running
   * handlers should watch this (pass it to `fetch`, stream iterators, etc.) and
   * unwind promptly. After it fires, the handler has `stopTimeout` ms to exit
   * before the process is force-killed.
   */
  readonly signal: AbortSignal;

  /**
   * Mark the beacon as ready/healthy. Optional — a beacon that never calls this
   * is still considered running — but calling it once a server is listening or
   * a client is connected records `readyAt` and lets dashboards distinguish
   * "starting" from "serving".
   */
  ready(): void;

  /**
   * Report liveness. When the beacon declared a `.heartbeat(interval)`, the
   * supervisor restarts the process if a heartbeat is not seen within the stall
   * deadline. No-op for beacons that didn't opt into heartbeats.
   */
  heartbeat(): void;

  /** Emit a structured log line, captured by the supervisor's subscribers. */
  log(message: string): void;

  /**
   * Register a cleanup callback run when a stop is requested (i.e. when
   * `signal` aborts) — close servers, disconnect clients, flush buffers.
   * Multiple callbacks run in registration order.
   */
  onStop(fn: () => void | Promise<void>): void;

  /**
   * Resolves once `signal` aborts. The idiomatic tail of a server/client
   * handler: start the thing, `ctx.ready()`, then `await ctx.untilStopped()`.
   */
  untilStopped(): Promise<void>;
}

/** A beacon's long-running body. Runs until it returns, throws, or `ctx.signal` aborts. */
export type BeaconHandler<TConfig = unknown> = (
  ctx: BeaconContext<TConfig>,
) => Promise<void> | void;

/**
 * Sleep for `ms`, resolving early (without rejecting) if `signal` aborts first.
 * Used by the `.poll()` loop so a stop request interrupts the wait between ticks.
 */
export function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
