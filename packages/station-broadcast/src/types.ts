export type FailurePolicy = "fail-fast" | "skip-downstream" | "continue";

export type BroadcastRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type BroadcastNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface BroadcastRun {
  id: string;
  broadcastName: string;
  /** JSON-serialized input provided when the broadcast was triggered. */
  input: string;
  status: BroadcastRunStatus;
  failurePolicy: FailurePolicy;
  /** Max time (ms) the entire broadcast may run before being auto-failed. */
  timeout?: number;
  /** Recurring interval (e.g. "5m"). */
  interval?: string;
  nextRunAt?: Date;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
}

export type BroadcastRunPatch = Partial<Omit<BroadcastRun, "id" | "broadcastName" | "createdAt">>;

export type BroadcastNodeSkipReason = "guard" | "upstream-failed" | "cancelled";

export interface BroadcastNodeRun {
  id: string;
  broadcastRunId: string;
  nodeName: string;
  signalName: string;
  /** Links to the signal Run record created for this node. */
  signalRunId?: string;
  status: BroadcastNodeStatus;
  /** Why this node was skipped (only set when status is "skipped"). */
  skipReason?: BroadcastNodeSkipReason;
  /** JSON-serialized input passed to the signal. */
  input?: string;
  /** JSON-serialized output from the completed signal. */
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export type BroadcastNodeRunPatch = Partial<Omit<BroadcastNodeRun, "id" | "broadcastRunId" | "nodeName" | "signalName">>;
