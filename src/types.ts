export type QueueEntryKind = "trigger" | "recurring";

export type EntryStatus = "pending" | "running" | "completed" | "failed";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
export const DEFAULT_MAX_ATTEMPTS = 1; // no retry by default

export interface QueueEntry {
  id: string;
  signalName: string;
  kind: QueueEntryKind;
  input: string; // JSON-serialized
  status: EntryStatus;
  attempts: number;
  maxAttempts: number;
  timeout: number; // ms
  interval?: string; // e.g. "every 5m" (recurring only)
  nextRunAt?: Date;
  lastRunAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}
