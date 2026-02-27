import type { Run, Step } from "../types.js";

/**
 * Messages sent from the child process (bootstrap) to the parent (runner)
 * via Node.js IPC channel.
 */
export interface IPCMessage {
  type: "run:started" | "run:completed" | "run:failed" | "step:completed";
  runId: string;
  signalName: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * Subscriber interface for signal lifecycle events.
 * All methods are optional — implement only the events you care about.
 */
export interface SignalSubscriber {
  /** Signal file discovered during auto-discovery. */
  onSignalDiscovered?(event: { signalName: string; filePath: string }): void;

  /** Run marked as running, child process about to spawn. */
  onRunDispatched?(event: { run: Run }): void;

  /** Child process confirmed signal found and is about to execute. */
  onRunStarted?(event: { run: Run }): void;

  /** Signal completed successfully. */
  onRunCompleted?(event: { run: Run; output?: string }): void;

  /** Runner detected a timeout on a running run. */
  onRunTimeout?(event: { run: Run }): void;

  /** Run reset to pending for another attempt. */
  onRunRetry?(event: {
    run: Run;
    attempt: number;
    maxAttempts: number;
  }): void;

  /** Run failed terminally (retries exhausted or unrecoverable error). */
  onRunFailed?(event: { run: Run; error?: string }): void;

  /** Run was cancelled via runner.cancel(). */
  onRunCancelled?(event: { run: Run }): void;

  /** Run skipped due to concurrency limit or backoff. */
  onRunSkipped?(event: { run: Run; reason: string }): void;

  /** Recurring run scheduled for its next execution. */
  onRunRescheduled?(event: { run: Run; nextRunAt: Date }): void;

  /** A step within a run completed. */
  onStepCompleted?(event: { run: Run; step: Step }): void;

  /** Console output captured from the child process. */
  onLogOutput?(event: {
    run: Run;
    level: "stdout" | "stderr";
    message: string;
  }): void;
}

export { ConsoleSubscriber } from "./console.js";
