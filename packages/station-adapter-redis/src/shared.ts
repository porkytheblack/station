import type { Run, Step } from "station-signal";
import type {
  BroadcastRun,
  BroadcastNodeRun,
} from "station-broadcast";

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/** Build a Redis key with the configured prefix. */
export function key(prefix: string, ...parts: string[]): string {
  return `${prefix}:${parts.join(":")}`;
}

// Signal run keys
export const runHashKey = (prefix: string, id: string) => key(prefix, "run", id);
export const pendingRunsKey = (prefix: string) => key(prefix, "runs", "pending");
export const runningRunsKey = (prefix: string) => key(prefix, "runs", "running");
export const signalRunsKey = (prefix: string, signalName: string) => key(prefix, "runs", "signal", signalName);
export const statusRunsKey = (prefix: string, signalName: string, status: string) => key(prefix, "runs", "status", signalName, status);
export const completedAtRunsKey = (prefix: string) => key(prefix, "runs", "completed-at");

// Signal step keys
export const stepHashKey = (prefix: string, id: string) => key(prefix, "step", id);
export const runStepsKey = (prefix: string, runId: string) => key(prefix, "run-steps", runId);

// Broadcast run keys
export const broadcastRunHashKey = (prefix: string, id: string) => key(prefix, "broadcast-run", id);
export const pendingBroadcastRunsKey = (prefix: string) => key(prefix, "broadcast-runs", "pending");
export const runningBroadcastRunsKey = (prefix: string) => key(prefix, "broadcast-runs", "running");
export const broadcastNameRunsKey = (prefix: string, broadcastName: string) => key(prefix, "broadcast-runs", "name", broadcastName);
export const broadcastStatusRunsKey = (prefix: string, broadcastName: string, status: string) => key(prefix, "broadcast-runs", "status", broadcastName, status);
export const completedAtBroadcastRunsKey = (prefix: string) => key(prefix, "broadcast-runs", "completed-at");

// Broadcast node run keys
export const nodeRunHashKey = (prefix: string, id: string) => key(prefix, "node-run", id);
export const broadcastRunNodesKey = (prefix: string, broadcastRunId: string) => key(prefix, "broadcast-run-nodes", broadcastRunId);

// ---------------------------------------------------------------------------
// Date / number serialization
// ---------------------------------------------------------------------------

/** Convert a Date to an ISO string for storage, or return undefined for null/undefined. */
export function dateToStr(value: Date | undefined | null): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/** Convert an ISO string back to a Date, or return undefined. */
export function strToDate(value: string | undefined | null): Date | undefined {
  if (value !== undefined && value !== null && value !== "") return new Date(value);
  return undefined;
}

/** Convert a Date to a Unix timestamp in milliseconds, defaulting to 0 for null/undefined. */
export function dateToScore(value: Date | undefined | null): number {
  if (value instanceof Date) return value.getTime();
  return 0;
}

// ---------------------------------------------------------------------------
// Run serialization
// ---------------------------------------------------------------------------

const RUN_DATE_FIELDS = new Set(["nextRunAt", "lastRunAt", "startedAt", "completedAt", "createdAt"]);
const RUN_NUMBER_FIELDS = new Set(["attempts", "maxAttempts", "timeout"]);

/** Convert a Run object to a flat string record for HSET. Omits undefined fields. */
export function runToHash(run: Run): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [field, value] of Object.entries(run)) {
    if (value === undefined || value === null) continue;
    if (RUN_DATE_FIELDS.has(field)) {
      hash[field] = (value as Date).toISOString();
    } else {
      hash[field] = String(value);
    }
  }
  return hash;
}

/** Convert a Redis hash (flat string record) back to a Run object with proper types. */
export function hashToRun(hash: Record<string, string>): Run {
  const run: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (RUN_DATE_FIELDS.has(field)) {
      run[field] = new Date(value);
    } else if (RUN_NUMBER_FIELDS.has(field)) {
      run[field] = Number(value);
    } else {
      run[field] = value;
    }
  }
  return run as unknown as Run;
}

// ---------------------------------------------------------------------------
// Step serialization
// ---------------------------------------------------------------------------

const STEP_DATE_FIELDS = new Set(["startedAt", "completedAt"]);

/** Convert a Step object to a flat string record for HSET. */
export function stepToHash(step: Step): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [field, value] of Object.entries(step)) {
    if (value === undefined || value === null) continue;
    if (STEP_DATE_FIELDS.has(field)) {
      hash[field] = (value as Date).toISOString();
    } else {
      hash[field] = String(value);
    }
  }
  return hash;
}

/** Convert a Redis hash back to a Step object. */
export function hashToStep(hash: Record<string, string>): Step {
  const step: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (STEP_DATE_FIELDS.has(field)) {
      step[field] = new Date(value);
    } else {
      step[field] = value;
    }
  }
  return step as unknown as Step;
}

// ---------------------------------------------------------------------------
// BroadcastRun serialization
// ---------------------------------------------------------------------------

const BROADCAST_RUN_DATE_FIELDS = new Set(["nextRunAt", "startedAt", "completedAt", "createdAt"]);
const BROADCAST_RUN_NUMBER_FIELDS = new Set(["timeout"]);

/** Convert a BroadcastRun to a flat string record for HSET. */
export function broadcastRunToHash(run: BroadcastRun): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [field, value] of Object.entries(run)) {
    if (value === undefined || value === null) continue;
    if (BROADCAST_RUN_DATE_FIELDS.has(field)) {
      hash[field] = (value as Date).toISOString();
    } else {
      hash[field] = String(value);
    }
  }
  return hash;
}

/** Convert a Redis hash back to a BroadcastRun. */
export function hashToBroadcastRun(hash: Record<string, string>): BroadcastRun {
  const run: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (BROADCAST_RUN_DATE_FIELDS.has(field)) {
      run[field] = new Date(value);
    } else if (BROADCAST_RUN_NUMBER_FIELDS.has(field)) {
      run[field] = Number(value);
    } else {
      run[field] = value;
    }
  }
  return run as unknown as BroadcastRun;
}

// ---------------------------------------------------------------------------
// BroadcastNodeRun serialization
// ---------------------------------------------------------------------------

const NODE_RUN_DATE_FIELDS = new Set(["startedAt", "completedAt"]);

/** Convert a BroadcastNodeRun to a flat string record for HSET. */
export function nodeRunToHash(nodeRun: BroadcastNodeRun): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [field, value] of Object.entries(nodeRun)) {
    if (value === undefined || value === null) continue;
    if (NODE_RUN_DATE_FIELDS.has(field)) {
      hash[field] = (value as Date).toISOString();
    } else {
      hash[field] = String(value);
    }
  }
  return hash;
}

/** Convert a Redis hash back to a BroadcastNodeRun. */
export function hashToNodeRun(hash: Record<string, string>): BroadcastNodeRun {
  const run: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (NODE_RUN_DATE_FIELDS.has(field)) {
      run[field] = new Date(value);
    } else {
      run[field] = value;
    }
  }
  return run as unknown as BroadcastNodeRun;
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

/**
 * Convert a patch object to Redis HSET args (flat field/value pairs).
 * Handles date fields, number fields, and string fields.
 * Returns both the args for HSET and the list of fields to HDEL (for undefined values).
 */
export function patchToHashArgs(
  patch: Record<string, unknown>,
  dateFields: Set<string>,
  numberFields: Set<string>,
  allowedKeys: Set<string>,
): { setArgs: Record<string, string>; delFields: string[] } {
  const setArgs: Record<string, string> = {};
  const delFields: string[] = [];

  for (const [field, value] of Object.entries(patch)) {
    if (!allowedKeys.has(field)) continue;
    if (value === undefined || value === null) {
      delFields.push(field);
    } else if (dateFields.has(field)) {
      setArgs[field] = (value as Date).toISOString();
    } else if (numberFields.has(field)) {
      setArgs[field] = String(value);
    } else {
      setArgs[field] = String(value);
    }
  }

  return { setArgs, delFields };
}

/** Allowed keys for Run patches. */
export const RUN_PATCH_KEYS = new Set([
  "input", "output", "error", "status", "attempts", "maxAttempts",
  "timeout", "interval", "nextRunAt", "lastRunAt", "startedAt", "completedAt",
]);

/** Allowed keys for Step patches. */
export const STEP_PATCH_KEYS = new Set([
  "status", "input", "output", "error", "startedAt", "completedAt",
]);

/** Allowed keys for BroadcastRun patches. */
export const BROADCAST_RUN_PATCH_KEYS = new Set([
  "input", "status", "failurePolicy", "timeout", "interval", "nextRunAt",
  "startedAt", "completedAt", "error",
]);

/** Allowed keys for BroadcastNodeRun patches. */
export const NODE_RUN_PATCH_KEYS = new Set([
  "signalRunId", "status", "skipReason", "input", "output", "error", "startedAt", "completedAt",
]);

// Re-export the field sets for use in patch methods
export { RUN_DATE_FIELDS, RUN_NUMBER_FIELDS, STEP_DATE_FIELDS, BROADCAST_RUN_DATE_FIELDS, BROADCAST_RUN_NUMBER_FIELDS, NODE_RUN_DATE_FIELDS };
