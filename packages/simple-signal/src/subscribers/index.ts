import type { QueueEntry } from "../types.js";

/**
 * Messages sent from the child process (bootstrap) to the parent (runner)
 * via Node.js IPC channel.
 */
export interface IPCMessage {
  type: "entry:started" | "entry:completed" | "entry:failed";
  entryId: string;
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

  /** Entry marked as running, child process about to spawn. */
  onEntryDispatched?(event: { entry: QueueEntry }): void;

  /** Child process confirmed signal found and is about to execute. */
  onEntryStarted?(event: { entry: QueueEntry }): void;

  /** Signal completed successfully. */
  onEntryCompleted?(event: { entry: QueueEntry }): void;

  /** Runner detected a timeout on a running entry. */
  onEntryTimeout?(event: { entry: QueueEntry }): void;

  /** Entry reset to pending for another attempt. */
  onEntryRetry?(event: {
    entry: QueueEntry;
    attempt: number;
    maxAttempts: number;
  }): void;

  /** Entry failed terminally (retries exhausted or unrecoverable error). */
  onEntryFailed?(event: { entry: QueueEntry; error?: string }): void;

  /** Recurring entry scheduled for its next run. */
  onEntryRescheduled?(event: { entry: QueueEntry; nextRunAt: Date }): void;

  /** Console output captured from the child process. */
  onLogOutput?(event: {
    entry: QueueEntry;
    level: "stdout" | "stderr";
    message: string;
  }): void;
}

export { ConsoleSubscriber } from "./console.js";
