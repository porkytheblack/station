export type RunKind = "trigger" | "recurring";
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
export const DEFAULT_MAX_ATTEMPTS = 1; // no retry by default

export interface Run {
  id: string;
  signalName: string;
  kind: RunKind;
  input: string;           // JSON-serialized
  output?: string;         // JSON-serialized TOutput
  error?: string;          // Error message on failure
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  timeout: number;         // ms
  interval?: string;       // e.g. "every 5m" (recurring only)
  nextRunAt?: Date;
  lastRunAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

/** Patchable fields on a Run — identity fields (id, signalName, kind, createdAt) are immutable. */
export type RunPatch = Partial<Omit<Run, "id" | "signalName" | "kind" | "createdAt">>;

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface Step {
  id: string;
  runId: string;
  name: string;
  status: StepStatus;
  input?: string;      // JSON - what was passed to this step
  output?: string;     // JSON - what this step returned
  error?: string;      // Error message on failure
  startedAt?: Date;
  completedAt?: Date;
}

/** Patchable fields on a Step — identity fields (id, runId, name) are immutable. */
export type StepPatch = Partial<Omit<Step, "id" | "runId" | "name">>;

/** Ordered step definition used internally by the framework. */
export interface StepDefinition {
  name: string;
  fn: (prev: unknown) => Promise<unknown>;
}
