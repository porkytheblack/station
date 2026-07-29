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
  | "stalled"
  /** Killed by the supervisor for not becoming ready within the startup deadline. */
  | "startup-timeout";

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
 * Exit code a beacon child uses to signal a non-restartable (fatal) failure —
 * invalid config, or the beacon not being found in its file. Carried reliably
 * by the process `exit` event, unlike an IPC message which can race the exit
 * (or be dropped by `process.exit`). The supervisor treats this code as
 * terminal and does not restart. 78 = `EX_CONFIG` from sysexits.h.
 */
export const FATAL_EXIT_CODE = 78;

/**
 * How a beacon definition comes to have running instances.
 *
 * - `auto`      — the supervisor seeds one instance and starts it on discovery.
 * - `manual`    — the supervisor seeds one instance but leaves it stopped until
 *                 someone starts it (dashboard or API).
 * - `on-demand` — no instance is seeded at all. Instances are created at runtime
 *                 through the API, each with its own config, and are removed
 *                 when they are deleted.
 */
export type StartMode = "auto" | "manual" | "on-demand";

/**
 * Where an instance record came from.
 *
 * - `definition` — seeded by the supervisor from the beacon file. There is at
 *                  most one per beacon, its id is the beacon name, and it can
 *                  be stopped but not deleted.
 * - `api`        — created at runtime (dashboard / API). Fully removable.
 */
export type BeaconInstanceOrigin = "definition" | "api";

/**
 * A supervised instance of a beacon definition. A definition may have many:
 * the one seeded from the file (`origin: "definition"`, id === beacon name)
 * plus any number created at runtime with their own config. The supervisor
 * drives each one independently between its desired state and its observed
 * lifecycle status.
 */
export interface BeaconInstance {
  /**
   * Unique instance id — the key everything else hangs off. The
   * definition-owned instance uses the beacon name as its id, so pre-existing
   * single-instance records keep working unchanged.
   */
  id: string;
  /** Name of the beacon definition this instance runs. */
  beaconName: string;
  /** Optional human-readable label for runtime-created instances. */
  label?: string;
  /** Whether this instance came from the beacon file or was created at runtime. */
  origin: BeaconInstanceOrigin;
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

/** Identity fields (id, beaconName, origin, createdAt) are immutable; everything else is patchable. */
export type BeaconInstancePatch = Partial<
  Omit<BeaconInstance, "id" | "beaconName" | "origin" | "createdAt">
>;

/** Lifecycle event kinds recorded to the optional event log. */
export type BeaconEventType =
  | "created"
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
  /** The instance the event belongs to. */
  instanceId: string;
  /** The beacon definition the instance runs — lets a definition-wide timeline be queried directly. */
  beaconName: string;
  incarnation: number;
  type: BeaconEventType;
  message?: string;
  at: Date;
}

/**
 * Instance ids appear in URLs and adapter primary keys. Runtime-created ids are
 * caller-supplied, so they're constrained to an unambiguous, path-safe subset.
 */
export const VALID_INSTANCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

/** Upper bound on an instance id, so a caller can't blow past adapter column widths. */
export const MAX_INSTANCE_ID_LENGTH = 128;
