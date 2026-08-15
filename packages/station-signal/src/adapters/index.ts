import type {
  ListAllRunsOptions,
  ListRunsOptions,
  Run,
  RunClaim,
  RunPatch,
  RunStatus,
  Step,
  StepPatch,
} from "../types.js";

export interface SignalQueueAdapter {
  // Run methods
  addRun(run: Run): Promise<void>;
  removeRun(id: string): Promise<void>;
  /**
   * Runs ready to dispatch (pending, next_run_at due), oldest first.
   * `limit` bounds the batch — the runner only dispatches a bounded number
   * per tick, so fetching the whole backlog every poll is wasted work.
   */
  getRunsDue(limit?: number): Promise<Run[]>;
  getRunsRunning(): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  /**
   * Atomically claim one due pending run. A null result means another station
   * won the race or the run is no longer eligible. Implement this for safe
   * multi-station execution; runners retain a legacy fallback for custom
   * single-process adapters.
   */
  claimRun?(id: string, claim: RunClaim): Promise<Run | null>;
  /** Atomically cancel a pending or running run. */
  cancelRun?(id: string, completedAt: Date): Promise<boolean>;
  /** Extend a live lease only when `leaseToken` still owns the run. */
  renewRunLease?(id: string, leaseToken: string, leaseExpiresAt: Date, now?: Date): Promise<boolean>;
  /** Apply a patch only while `leaseToken` owns a running attempt. */
  updateClaimedRun?(id: string, leaseToken: string, patch: RunPatch): Promise<boolean>;
  /** Recover expired attempts. Exhausted attempts become failed. */
  requeueExpiredRuns?(now: Date): Promise<number>;
  /**
   * Runs for one signal. With no `options`, returns the full history in the
   * adapter's natural order (back-compat). With `options`, returns
   * newest-first, filtered by `statuses`, and bounded by `limit`/`offset`.
   */
  listRuns(signalName: string, options?: ListRunsOptions): Promise<Run[]>;
  /**
   * Runs across all signals (or one, if `signalName` is set), newest-first,
   * bounded by `limit`/`offset` and filtered by `statuses`. Lets the
   * dashboard page history without loading every signal's full run list.
   */
  listAllRuns(options?: ListAllRunsOptions): Promise<Run[]>;
  /**
   * Count of runs grouped by status (optionally for one signal). Powers the
   * dashboard stats tiles without materializing rows.
   */
  countRunsByStatus(options?: { signalName?: string }): Promise<Partial<Record<RunStatus, number>>>;

  /** Check if any run for the given signal has one of the specified statuses. */
  hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean>;

  /** Purge runs in terminal statuses older than the given date. Returns count deleted. */
  purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number>;

  // Step methods
  addStep(step: Step): Promise<void>;
  updateStep(id: string, patch: StepPatch): Promise<void>;
  getSteps(runId: string): Promise<Step[]>;
  removeSteps(runId: string): Promise<void>;

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

/**
 * Metadata an adapter carries so child processes can reconstruct it.
 * Adapters that implement SerializableAdapter are fully automatic —
 * no extra runner config needed.
 */
export interface AdapterManifest {
  /** Registry name (e.g. "sqlite"). Matches registerAdapter() name. */
  name: string;
  /** Serializable options to pass to the factory. */
  options: Record<string, unknown>;
  /**
   * Resolved absolute path/URL to the module that registers this adapter.
   * Only needed for external (non-built-in) adapters.
   */
  moduleUrl?: string;
}

/**
 * Adapters that can be reconstructed in child processes implement this.
 * MemoryAdapter intentionally does NOT implement this since it cannot
 * share state across processes.
 */
export interface SerializableAdapter extends SignalQueueAdapter {
  toManifest(): AdapterManifest;
}

export function isSerializableAdapter(
  adapter: SignalQueueAdapter,
): adapter is SerializableAdapter {
  return typeof (adapter as SerializableAdapter).toManifest === "function";
}

export { MemoryAdapter } from "./memory.js";
export { registerAdapter, createAdapter, hasAdapter } from "./registry.js";
