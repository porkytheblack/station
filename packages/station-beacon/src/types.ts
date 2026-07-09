/**
 * Core data model for station-beacon.
 *
 * A beacon is a long-running, supervised unit. Unlike a signal Run (which is
 * created per trigger and reaches a terminal status), a beacon has a single
 * long-lived `BeaconInstance` per name that the supervisor drives between a
 * desired state and an observed lifecycle status.
 */

/** How the supervisor reacts when a beacon's process exits. */
export type RestartPolicy = "always" | "on-failure" | "never";

/**
 * The lifecycle status of a beacon instance, as observed by the supervisor.
 *
 * - `stopped`  — not running; desired state is stopped (or a `never`-policy
 *                beacon exited cleanly).
 * - `starting` — child process is being spawned for a new incarnation.
 * - `running`  — child process is alive and executing the handler.
 * - `stopping` — a graceful stop was requested (SIGTERM sent); awaiting exit.
 * - `backoff`  — the process exited and a restart is scheduled at `nextRestartAt`.
 * - `errored`  — terminal failure; the supervisor will not restart it
 *                (policy `never` after a failure, or backoff attempts exhausted).
 */
export type BeaconStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "backoff"
  | "errored";

/** What the operator wants the beacon to be doing. The supervisor reconciles toward this. */
export type DesiredState = "running" | "stopped";

/** How a beacon incarnation ended — drives the restart decision. */
export type ExitReason =
  /** Process exited with code 0 without being asked to stop. */
  | "clean"
  /** Non-zero exit, crash, or the handler threw. */
  | "failure"
  /** The supervisor asked it to stop (desired=stopped or shutdown). */
  | "stopped"
  /** Killed by the supervisor after missing its heartbeat deadline. */
  | "stalled";

/** Terminal-ish statuses where no child process is expected to be alive. */
export const INACTIVE_STATUSES: readonly BeaconStatus[] = ["stopped", "backoff", "errored"];

/** Resolved (fully-defaulted) restart backoff parameters. */
export interface BackoffConfig {
  /** Delay before the first restart, in ms. */
  baseMs: number;
  /** Multiplier applied per consecutive restart. */
  factor: number;
  /** Upper bound on any single restart delay, in ms. */
  maxMs: number;
  /**
   * Once a process has stayed up (running) at least this long, the consecutive
   * restart counter resets so a later crash restarts quickly instead of at the
   * top of the backoff curve.
   */
  resetAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  resetAfterMs: 60_000,
};

/** Default grace period (ms) a beacon gets to exit after SIGTERM before SIGKILL. */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/**
 * The supervised record for a beacon. Exactly one exists per beacon name; the
 * supervisor updates it as incarnations start, become ready, and exit.
 */
export interface BeaconInstance {
  beaconName: string;
  status: BeaconStatus;
  desiredState: DesiredState;
  /** Total number of incarnations started over this instance's lifetime. */
  incarnation: number;
  /** Consecutive restart attempts since the beacon was last considered healthy. */
  restartCount: number;
  /** OS process id of the current incarnation, when running. */
  pid?: number;
  /** JSON-serialized resolved config used for the current incarnation. */
  config?: string;
  /** When the current incarnation's process was spawned. */
  startedAt?: Date;
  /** When the handler last called `ctx.ready()`. */
  readyAt?: Date;
  /** When the handler last called `ctx.heartbeat()`. */
  lastHeartbeatAt?: Date;
  /** When the most recent incarnation exited. */
  lastExitAt?: Date;
  /** How the most recent incarnation exited. */
  lastExitReason?: ExitReason;
  /** Error message from the most recent failing incarnation. */
  lastError?: string;
  /** When, in `backoff`, the next restart is scheduled. */
  nextRestartAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Identity fields (beaconName, createdAt) are immutable; everything else is patchable. */
export type BeaconInstancePatch = Partial<Omit<BeaconInstance, "beaconName" | "createdAt">>;

/** Lifecycle event kinds recorded to the optional event log. */
export type BeaconEventType =
  | "starting"
  | "ready"
  | "heartbeat"
  | "exited"
  | "restart-scheduled"
  | "stopped"
  | "errored"
  | "stalled";

/** An append-only lifecycle event, for run history / dashboards. */
export interface BeaconEvent {
  id: string;
  beaconName: string;
  incarnation: number;
  type: BeaconEventType;
  message?: string;
  at: Date;
}
