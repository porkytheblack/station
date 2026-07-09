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
/** Set of all signal names seen — lets listAllRuns/countRunsByStatus enumerate signals. */
export const signalNamesKey = (prefix: string) => key(prefix, "runs", "signal-names");

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

// Dynamic broadcast definition keys (one hash per version, plus a sorted-set
// per name so we can list and find the latest, plus a global set of names).
export const broadcastDefinitionKey = (prefix: string, name: string, version: number) =>
  key(prefix, "broadcast-def", name, String(version));
export const broadcastDefinitionVersionsKey = (prefix: string, name: string) =>
  key(prefix, "broadcast-def-versions", name);
export const broadcastDefinitionNamesKey = (prefix: string) =>
  key(prefix, "broadcast-defs", "names");
/** Per-name atomic counter used by saveDefinition to bump versions. */
export const broadcastDefinitionCounterKey = (prefix: string, name: string) =>
  key(prefix, "broadcast-def-counter", name);

// Schedule keys
export const scheduleHashKey = (prefix: string, id: string) => key(prefix, "schedule", id);
export const scheduleDueKey = (prefix: string) => key(prefix, "schedules", "due");
export const scheduleAllKey = (prefix: string) => key(prefix, "schedules", "all");
export const scheduleByKindKey = (prefix: string, kind: string) => key(prefix, "schedules", "by-kind", kind);

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
  "startedAt", "completedAt", "error", "definitionSnapshot",
]);

/** Allowed keys for BroadcastNodeRun patches. */
export const NODE_RUN_PATCH_KEYS = new Set([
  "signalRunId", "status", "skipReason", "input", "output", "error", "startedAt", "completedAt",
]);

// Re-export the field sets for use in patch methods
export { RUN_DATE_FIELDS, RUN_NUMBER_FIELDS, STEP_DATE_FIELDS, BROADCAST_RUN_DATE_FIELDS, BROADCAST_RUN_NUMBER_FIELDS, NODE_RUN_DATE_FIELDS };

// ---------------------------------------------------------------------------
// Atomic run update (Lua)
// ---------------------------------------------------------------------------

/**
 * Atomically apply a run/broadcast-run patch and reconcile its status indexes.
 * The previous JS read-modify-write read the status outside the transaction,
 * so two runners could interleave and leave the id in the wrong (or both)
 * status set/scheduling zset. This script reads the current status INSIDE the
 * atomic script and moves index membership based on that authoritative value,
 * so membership can never tear from the stored status.
 *
 * KEYS: [hashKey, pendingZset, runningZset, completedAtZset]
 * ARGV:
 *   1 id
 *   2 statusKeyBase   — e.g. "<prefix>:runs:status:<name>:"; status is appended
 *   3 setArgs JSON    — object of field→string to HSET
 *   4 delFields JSON  — array of fields to HDEL
 *   5 newStatus       — "" when the patch does not change status
 *   6 pendingScore    — score used when transitioning INTO pending
 *   7 runningScore    — score used when transitioning INTO running
 *   8 completedOp     — "" (no change) | "DEL" | numeric score string
 *   9 nextRunAtInPatch— "1"/"0": patch set nextRunAt while status unchanged
 *  10 nextRunAtScore  — score for the status-unchanged pending nextRunAt update
 * Returns 1 if the run existed and was updated, 0 if the hash was missing.
 */
export const ATOMIC_RUN_UPDATE_LUA = `
local hashKey = KEYS[1]
if redis.call('EXISTS', hashKey) == 0 then return 0 end
local id = ARGV[1]
local statusBase = ARGV[2]
local oldStatus = redis.call('HGET', hashKey, 'status')
local setArgs = cjson.decode(ARGV[3])
for k, v in pairs(setArgs) do redis.call('HSET', hashKey, k, v) end
local delFields = cjson.decode(ARGV[4])
for _, f in ipairs(delFields) do redis.call('HDEL', hashKey, f) end
local newStatus = ARGV[5]
if newStatus ~= '' and newStatus ~= oldStatus then
  if oldStatus then redis.call('SREM', statusBase .. oldStatus, id) end
  redis.call('SADD', statusBase .. newStatus, id)
  if oldStatus == 'pending' then redis.call('ZREM', KEYS[2], id)
  elseif oldStatus == 'running' then redis.call('ZREM', KEYS[3], id) end
  if newStatus == 'pending' then redis.call('ZADD', KEYS[2], ARGV[6], id)
  elseif newStatus == 'running' then redis.call('ZADD', KEYS[3], ARGV[7], id) end
else
  if oldStatus == 'pending' and ARGV[9] == '1' then
    redis.call('ZADD', KEYS[2], ARGV[10], id)
  end
end
local completedOp = ARGV[8]
if completedOp == 'DEL' then redis.call('ZREM', KEYS[4], id)
elseif completedOp ~= '' then redis.call('ZADD', KEYS[4], completedOp, id) end
return 1
`;

/**
 * Build the ARGV[3..10] slice shared by both run and broadcast-run atomic
 * updates from a patch's computed HSET args and the fallback (current) run.
 */
export function atomicUpdateArgs(
  setArgs: Record<string, string>,
  delFields: string[],
  patch: { status?: string; nextRunAt?: Date | null; startedAt?: Date | null; completedAt?: Date | null },
  current: { nextRunAt?: Date; startedAt?: Date },
): string[] {
  const newStatus = patch.status ?? "";
  // Scores only affect ordering within a zset, not membership, so using the
  // (possibly slightly stale) current value as a fallback is safe.
  const pendingScore = String(dateToScore(patch.nextRunAt ?? current.nextRunAt));
  const runningScore = String(dateToScore(patch.startedAt ?? current.startedAt));
  let completedOp = "";
  if (patch.completedAt !== undefined) {
    completedOp = patch.completedAt === null ? "DEL" : String((patch.completedAt as Date).getTime());
  }
  const nextRunAtInPatch = patch.nextRunAt !== undefined ? "1" : "0";
  const nextRunAtScore = String(dateToScore(patch.nextRunAt ?? undefined));
  return [
    JSON.stringify(setArgs),
    JSON.stringify(delFields),
    newStatus,
    pendingScore,
    runningScore,
    completedOp,
    nextRunAtInPatch,
    nextRunAtScore,
  ];
}
