import type { BeaconInstance, ExitReason } from "../types.js";

/**
 * Messages sent from a beacon child process to the supervisor over the Node.js
 * IPC channel. Exit codes and stdout/stderr flow through the normal child
 * process streams; IPC carries the in-band lifecycle signals the handler emits.
 */
export interface BeaconIPCMessage {
  type:
    | "beacon:started"
    | "beacon:ready"
    | "beacon:heartbeat"
    | "beacon:log"
    | "beacon:stopping"
    | "beacon:error";
  beaconName: string;
  incarnation: number;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * Message sent from the supervisor to a beacon child right after spawn. Carries
 * the beacon config and signal-adapter configuration (which may contain DB
 * credentials) over the private IPC channel so they never appear in the child's
 * environment — env is world-readable to same-user processes via /proc.
 */
export interface BeaconJobInitMessage {
  type: "job:init";
  data: {
    config: string;
    signalAdapterName?: string;
    signalAdapterOptions?: Record<string, unknown>;
    signalAdapterImport?: string;
  };
}

/**
 * Subscriber interface for beacon supervision events. All methods are optional
 * — implement only the events you care about. Errors thrown from a handler are
 * caught and logged by the supervisor.
 */
export interface BeaconSubscriber {
  /** A beacon definition was found during auto-discovery. */
  onBeaconDiscovered?(event: { beaconName: string; filePath: string }): void;

  /** The supervisor is about to spawn a child process for a beacon. */
  onBeaconStarting?(event: { instance: BeaconInstance }): void;

  /** The child process reported that the handler has started executing. */
  onBeaconStarted?(event: { instance: BeaconInstance }): void;

  /** The handler called `ctx.ready()`. */
  onBeaconReady?(event: { instance: BeaconInstance }): void;

  /** A heartbeat was received from a beacon that opted into `.heartbeat()`. */
  onBeaconHeartbeat?(event: { instance: BeaconInstance }): void;

  /** The child process exited (for any reason). */
  onBeaconExited?(event: { instance: BeaconInstance; reason: ExitReason; code: number | null }): void;

  /** A restart was scheduled after an exit; fires with the backoff delay. */
  onBeaconRestartScheduled?(event: {
    instance: BeaconInstance;
    delayMs: number;
    nextRestartAt: Date;
  }): void;

  /** The beacon reached a cleanly stopped state (desired=stopped satisfied). */
  onBeaconStopped?(event: { instance: BeaconInstance }): void;

  /** The beacon failed terminally and will not be restarted. */
  onBeaconErrored?(event: { instance: BeaconInstance; error?: string }): void;

  /** A heartbeat deadline was missed; the supervisor is killing the process. */
  onBeaconStalled?(event: { instance: BeaconInstance }): void;

  /** Log output — from `ctx.log()` (level "log") or captured stdout/stderr. */
  onBeaconLog?(event: {
    instance: BeaconInstance;
    level: "log" | "stdout" | "stderr";
    message: string;
  }): void;
}

export { ConsoleBeaconSubscriber } from "./console.js";
