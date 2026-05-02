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
  /**
   * For runs of dynamic broadcasts: a JSON-serialized DynamicBroadcastSpec
   * captured at trigger time. The advance loop reads from this rather than
   * the live registry so edits to the spec don't mutate in-flight runs.
   */
  definitionSnapshot?: string;
}

// ─── Dynamic broadcasts ─────────────────────────────────────────────

/**
 * A JSON-serialized expression AST. Stored as `unknown` here to avoid a
 * hard dependency on `station-expressions` from the core types module —
 * adapters round-trip the value untouched.
 */
export type DynamicExpr = unknown;

export interface DynamicNodeSpec {
  /** Node label, unique within the spec. */
  name: string;
  /** Must resolve to a registered signal at materialization time. */
  signalName: string;
  dependsOn: string[];
  /** ExprNode JSON; absent ⇒ pass-through (single-dep) or upstream object (multi-dep) */
  input?: DynamicExpr;
  /** ExprNode JSON returning boolean; absent ⇒ always run */
  when?: DynamicExpr;
}

export interface DynamicBroadcastSpec {
  /** Namespace-scoped — never collides with file-defined broadcasts. */
  name: string;
  /** Monotonically incremented on each save. */
  version: number;
  failurePolicy: FailurePolicy;
  timeout?: number;
  nodes: DynamicNodeSpec[];
  createdAt: Date;
  updatedAt: Date;
  /** API key id or session user that authored this version. */
  createdBy?: string;
  /** Soft-delete marker — definitions are retained for run-history inspection. */
  deletedAt?: Date;
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
