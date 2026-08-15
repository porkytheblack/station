import { randomUUID } from "node:crypto";
import Redis from "ioredis";
export type { Redis } from "ioredis";
import type { SerializableAdapter, AdapterManifest, ListAllRunsOptions, ListRunsOptions, Run, RunClaim, RunPatch, RunStatus, Step, StepPatch } from "station-signal";
import { registerAdapter } from "station-signal";

import {
  runHashKey,
  pendingRunsKey,
  runningRunsKey,
  signalRunsKey,
  signalNamesKey,
  statusRunsKey,
  completedAtRunsKey,
  stepHashKey,
  runStepsKey,
  runToHash,
  hashToRun,
  stepToHash,
  hashToStep,
  dateToScore,
  patchToHashArgs,
  ATOMIC_RUN_UPDATE_LUA,
  atomicUpdateArgs,
  RUN_PATCH_KEYS,
  STEP_PATCH_KEYS,
  RUN_DATE_FIELDS,
  RUN_NUMBER_FIELDS,
  STEP_DATE_FIELDS,
} from "./shared.js";

/** All run statuses — used to enumerate status index sets. */
const ALL_RUN_STATUSES: RunStatus[] = ["pending", "running", "completed", "failed", "cancelled"];

const MODULE_URL = import.meta.url;

const ADD_RUN_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local fields = cjson.decode(ARGV[8])
for k, v in pairs(fields) do redis.call('HSET', KEYS[1], k, v) end
if ARGV[3] == 'pending' then redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
elseif ARGV[3] == 'running' then redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1]) end
redis.call('ZADD', KEYS[4], ARGV[6], ARGV[1])
redis.call('SADD', KEYS[5], ARGV[2])
redis.call('SADD', KEYS[6], ARGV[1])
if ARGV[7] ~= '' then redis.call('ZADD', KEYS[7], ARGV[7], ARGV[1]) end
return 1
`;

const CLAIM_RUN_LUA = `
local hashKey = KEYS[1]
if redis.call('HGET', hashKey, 'status') ~= 'pending' then return 0 end
local due = redis.call('ZSCORE', KEYS[2], ARGV[1])
if not due or tonumber(due) > tonumber(ARGV[2]) then return 0 end
redis.call('HSET', hashKey,
  'status', 'running', 'stationId', ARGV[3], 'leaseToken', ARGV[4],
  'leaseExpiresAt', ARGV[5], 'claimedAt', ARGV[6], 'startedAt', ARGV[6],
  'lastRunAt', ARGV[6])
redis.call('HINCRBY', hashKey, 'attempts', 1)
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('SREM', KEYS[4], ARGV[1])
redis.call('SADD', KEYS[5], ARGV[1])
return 1
`;

const CANCEL_RUN_LUA = `
local oldStatus = redis.call('HGET', KEYS[1], 'status')
if oldStatus ~= 'pending' and oldStatus ~= 'running' then return 0 end
local signalName = redis.call('HGET', KEYS[1], 'signalName')
if not signalName then return 0 end
redis.call('HSET', KEYS[1], 'status', 'cancelled', 'completedAt', ARGV[2])
redis.call('HDEL', KEYS[1], 'leaseToken', 'leaseExpiresAt', 'claimedAt')
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('SREM', ARGV[4] .. signalName .. ':' .. oldStatus, ARGV[1])
redis.call('SADD', ARGV[4] .. signalName .. ':cancelled', ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
return 1
`;

const RENEW_LEASE_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= 'running' then return 0 end
if redis.call('HGET', KEYS[1], 'leaseToken') ~= ARGV[1] then return 0 end
local currentExpiry = redis.call('HGET', KEYS[1], 'leaseExpiresAt')
if not currentExpiry or currentExpiry <= ARGV[3] then return 0 end
redis.call('HSET', KEYS[1], 'leaseExpiresAt', ARGV[2])
return 1
`;

const FENCED_UPDATE_LUA = `
local hashKey = KEYS[1]
if redis.call('EXISTS', hashKey) == 0 then return 0 end
if redis.call('HGET', hashKey, 'status') ~= 'running' then return 0 end
if redis.call('HGET', hashKey, 'leaseToken') ~= ARGV[1] then return 0 end
local id = ARGV[2]
local statusBase = ARGV[3]
local oldStatus = redis.call('HGET', hashKey, 'status')
local setArgs = cjson.decode(ARGV[4])
for k, v in pairs(setArgs) do redis.call('HSET', hashKey, k, v) end
local delFields = cjson.decode(ARGV[5])
for _, f in ipairs(delFields) do redis.call('HDEL', hashKey, f) end
local newStatus = ARGV[6]
if newStatus ~= '' and newStatus ~= oldStatus then
  if oldStatus then redis.call('SREM', statusBase .. oldStatus, id) end
  redis.call('SADD', statusBase .. newStatus, id)
  if oldStatus == 'pending' then redis.call('ZREM', KEYS[2], id)
  elseif oldStatus == 'running' then redis.call('ZREM', KEYS[3], id) end
  if newStatus == 'pending' then redis.call('ZADD', KEYS[2], ARGV[7], id)
  elseif newStatus == 'running' then redis.call('ZADD', KEYS[3], ARGV[8], id) end
end
local completedOp = ARGV[9]
if completedOp == 'DEL' then redis.call('ZREM', KEYS[4], id)
elseif completedOp ~= '' then redis.call('ZADD', KEYS[4], completedOp, id) end
return 1
`;

export interface RedisAdapterOptions {
  /** Redis connection URL. Defaults to "redis://localhost:6379". */
  url?: string;
  /** Existing ioredis instance. Takes precedence over `url` if provided. */
  redis?: Redis;
  /** Key prefix for all Redis keys. Defaults to "station". */
  prefix?: string;
}

export class RedisAdapter implements SerializableAdapter {
  private redis: Redis;
  private prefix: string;
  private ownsConnection: boolean;
  private options: RedisAdapterOptions;

  constructor(options: RedisAdapterOptions = {}) {
    this.options = options;
    this.prefix = options.prefix ?? "station";

    if (options.redis) {
      this.redis = options.redis;
      this.ownsConnection = false;
    } else {
      this.redis = new Redis(options.url ?? "redis://localhost:6379", {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
      });
      this.ownsConnection = true;
    }
  }

  toManifest(): AdapterManifest {
    return {
      name: "redis",
      options: {
        url: this.options.url,
        prefix: this.options.prefix,
      },
      moduleUrl: MODULE_URL,
    };
  }

  // ---------------------------------------------------------------------------
  // Run methods
  // ---------------------------------------------------------------------------

  async addRun(run: Run): Promise<void> {
    const hash = runToHash(run);
    const hashKey = runHashKey(this.prefix, run.id);
    const inserted = await this.redis.eval(
      ADD_RUN_LUA,
      7,
      hashKey,
      pendingRunsKey(this.prefix),
      runningRunsKey(this.prefix),
      signalRunsKey(this.prefix, run.signalName),
      signalNamesKey(this.prefix),
      statusRunsKey(this.prefix, run.signalName, run.status),
      completedAtRunsKey(this.prefix),
      run.id,
      run.signalName,
      run.status,
      String(dateToScore(run.nextRunAt)),
      String(dateToScore(run.startedAt)),
      String(run.createdAt.getTime()),
      run.completedAt ? String(run.completedAt.getTime()) : "",
      JSON.stringify(hash),
    );
    if (Number(inserted) !== 1) {
      throw new Error(`Run with id "${run.id}" already exists`);
    }
  }

  async removeRun(id: string): Promise<void> {
    const run = await this.getRun(id);
    if (!run) return;

    // Get all step IDs for this run
    const stepIds = await this.redis.smembers(runStepsKey(this.prefix, run.id));

    const pipeline = this.redis.multi();

    // Delete the run hash
    pipeline.del(runHashKey(this.prefix, id));

    // Remove from status sorted sets
    pipeline.zrem(pendingRunsKey(this.prefix), id);
    pipeline.zrem(runningRunsKey(this.prefix), id);

    // Remove from signal index
    pipeline.zrem(signalRunsKey(this.prefix, run.signalName), id);

    // Remove from status set
    pipeline.srem(statusRunsKey(this.prefix, run.signalName, run.status), id);

    // Remove from completed-at index
    pipeline.zrem(completedAtRunsKey(this.prefix), id);

    // Delete all step hashes and the step index set
    for (const stepId of stepIds) {
      pipeline.del(stepHashKey(this.prefix, stepId));
    }
    pipeline.del(runStepsKey(this.prefix, id));

    await pipeline.exec();
  }

  async getRunsDue(limit?: number): Promise<Run[]> {
    const now = Date.now();
    const ids = limit !== undefined && limit >= 0
      ? await this.redis.zrangebyscore(pendingRunsKey(this.prefix), "-inf", String(now), "LIMIT", 0, limit)
      : await this.redis.zrangebyscore(pendingRunsKey(this.prefix), "-inf", String(now));
    if (ids.length === 0) return [];

    return this.fetchRunsByIds(ids);
  }

  async getRunsRunning(): Promise<Run[]> {
    const ids = await this.redis.zrange(runningRunsKey(this.prefix), 0, -1);
    if (ids.length === 0) return [];

    return this.fetchRunsByIds(ids);
  }

  async getRun(id: string): Promise<Run | null> {
    const hash = await this.redis.hgetall(runHashKey(this.prefix, id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToRun(hash);
  }

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const currentRun = await this.getRun(id);
    if (!currentRun) return;

    const { setArgs, delFields } = patchToHashArgs(
      patch as Record<string, unknown>,
      RUN_DATE_FIELDS,
      RUN_NUMBER_FIELDS,
      RUN_PATCH_KEYS,
    );

    if (Object.keys(setArgs).length === 0 && delFields.length === 0) return;

    // Atomic read-current-status + field update + index reconciliation, so
    // concurrent updaters cannot corrupt the status set / scheduling zsets.
    // signalName is immutable, so building the status-key base from the
    // JS-read run is safe; only the scheduling *scores* fall back to the
    // (harmlessly stale) current values.
    const statusKeyBase = statusRunsKey(this.prefix, currentRun.signalName, "");
    const argv = atomicUpdateArgs(setArgs, delFields, patch, currentRun);
    await this.redis.eval(
      ATOMIC_RUN_UPDATE_LUA,
      4,
      runHashKey(this.prefix, id),
      pendingRunsKey(this.prefix),
      runningRunsKey(this.prefix),
      completedAtRunsKey(this.prefix),
      id,
      statusKeyBase,
      ...argv,
    );
  }

  async claimRun(id: string, claim: RunClaim): Promise<Run | null> {
    const run = await this.getRun(id);
    if (!run) return null;
    const claimed = await this.redis.eval(
      CLAIM_RUN_LUA,
      5,
      runHashKey(this.prefix, id),
      pendingRunsKey(this.prefix),
      runningRunsKey(this.prefix),
      statusRunsKey(this.prefix, run.signalName, "pending"),
      statusRunsKey(this.prefix, run.signalName, "running"),
      id,
      String(claim.claimedAt.getTime()),
      claim.stationId,
      claim.leaseToken,
      claim.leaseExpiresAt.toISOString(),
      claim.claimedAt.toISOString(),
    );
    return Number(claimed) === 1 ? this.getRun(id) : null;
  }

  async cancelRun(id: string, completedAt: Date): Promise<boolean> {
    const cancelled = await this.redis.eval(
      CANCEL_RUN_LUA,
      4,
      runHashKey(this.prefix, id),
      pendingRunsKey(this.prefix),
      runningRunsKey(this.prefix),
      completedAtRunsKey(this.prefix),
      id,
      completedAt.toISOString(),
      String(completedAt.getTime()),
      `${this.prefix}:runs:status:`,
    );
    return Number(cancelled) === 1;
  }

  async renewRunLease(id: string, leaseToken: string, leaseExpiresAt: Date, now = new Date()): Promise<boolean> {
    const renewed = await this.redis.eval(
      RENEW_LEASE_LUA,
      1,
      runHashKey(this.prefix, id),
      leaseToken,
      leaseExpiresAt.toISOString(),
      now.toISOString(),
    );
    return Number(renewed) === 1;
  }

  async updateClaimedRun(id: string, leaseToken: string, patch: RunPatch): Promise<boolean> {
    const currentRun = await this.getRun(id);
    if (!currentRun) return false;
    const { setArgs, delFields } = patchToHashArgs(
      patch as Record<string, unknown>,
      RUN_DATE_FIELDS,
      RUN_NUMBER_FIELDS,
      RUN_PATCH_KEYS,
    );
    if (Object.keys(setArgs).length === 0 && delFields.length === 0) return false;
    const statusKeyBase = statusRunsKey(this.prefix, currentRun.signalName, "");
    const args = atomicUpdateArgs(setArgs, delFields, patch, currentRun);
    const updated = await this.redis.eval(
      FENCED_UPDATE_LUA,
      4,
      runHashKey(this.prefix, id),
      pendingRunsKey(this.prefix),
      runningRunsKey(this.prefix),
      completedAtRunsKey(this.prefix),
      leaseToken,
      id,
      statusKeyBase,
      ...args,
    );
    return Number(updated) === 1;
  }

  async requeueExpiredRuns(now: Date): Promise<number> {
    const running = await this.getRunsRunning();
    let recovered = 0;
    for (const run of running) {
      if (!run.leaseToken || !run.leaseExpiresAt || run.leaseExpiresAt > now) continue;
      const exhausted = run.attempts >= run.maxAttempts;
      const updated = await this.updateClaimedRun(run.id, run.leaseToken, exhausted ? {
        status: "failed",
        completedAt: now,
        error: "Station lease expired and all attempts were exhausted",
        leaseToken: undefined,
        leaseExpiresAt: undefined,
      } : {
        status: "pending",
        startedAt: undefined,
        lastRunAt: now,
        error: "Station lease expired; run recovered for retry",
        stationId: undefined,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        claimedAt: undefined,
      });
      if (updated) recovered++;
    }
    return recovered;
  }

  async listRuns(signalName: string, options?: ListRunsOptions): Promise<Run[]> {
    // ZREVRANGE returns IDs ordered by createdAt descending
    const ids = await this.redis.zrevrange(signalRunsKey(this.prefix, signalName), 0, -1);
    if (ids.length === 0) return [];

    const runs = await this.fetchRunsByIds(ids);
    return options ? applyRunListOptions(runs, options) : runs;
  }

  async listAllRuns(options?: ListAllRunsOptions): Promise<Run[]> {
    const names = options?.signalName
      ? [options.signalName]
      : await this.redis.smembers(signalNamesKey(this.prefix));
    if (names.length === 0) return [];

    // Gather run ids for every signal in one pipeline.
    const pipeline = this.redis.pipeline();
    for (const name of names) {
      pipeline.zrevrange(signalRunsKey(this.prefix, name), 0, -1);
    }
    const results = await pipeline.exec();
    const ids: string[] = [];
    if (results) {
      for (const [err, list] of results) {
        if (!err && Array.isArray(list)) ids.push(...(list as string[]));
      }
    }
    if (ids.length === 0) return [];

    const runs = await this.fetchRunsByIds(ids);
    // Merge-sort across signals: newest first.
    runs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return applyRunListOptions(runs, options ?? {});
  }

  async countRunsByStatus(options?: { signalName?: string }): Promise<Partial<Record<RunStatus, number>>> {
    const names = options?.signalName
      ? [options.signalName]
      : await this.redis.smembers(signalNamesKey(this.prefix));
    if (names.length === 0) return {};

    // One SCARD per (signal, status) in a single pipeline; sum per status.
    const pipeline = this.redis.pipeline();
    const statusOrder: RunStatus[] = [];
    for (const name of names) {
      for (const status of ALL_RUN_STATUSES) {
        pipeline.scard(statusRunsKey(this.prefix, name, status));
        statusOrder.push(status);
      }
    }
    const results = await pipeline.exec();
    const counts: Partial<Record<RunStatus, number>> = {};
    if (results) {
      for (let i = 0; i < results.length; i++) {
        const [err, card] = results[i];
        if (err) continue;
        const n = Number(card);
        if (n > 0) {
          const status = statusOrder[i];
          counts[status] = (counts[status] ?? 0) + n;
        }
      }
    }
    return counts;
  }

  async hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;

    // Redis deletes empty sets, so a single EXISTS over all status-set keys
    // is equivalent to checking each SCARD — one round trip instead of N.
    const keys = statuses.map((status) => statusRunsKey(this.prefix, signalName, status));
    const count = await this.redis.exists(...keys);
    return count > 0;
  }

  async purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;

    const statusSet = new Set(statuses);
    const cutoff = olderThan.getTime();

    // Get all run IDs with completedAt before the cutoff
    const candidateIds = await this.redis.zrangebyscore(
      completedAtRunsKey(this.prefix),
      "-inf",
      String(cutoff - 1), // exclusive of cutoff itself: "older than"
    );

    if (candidateIds.length === 0) return 0;

    // Check all candidates' statuses in one pipeline instead of N round trips
    const statusPipeline = this.redis.pipeline();
    for (const id of candidateIds) {
      statusPipeline.hget(runHashKey(this.prefix, id), "status");
    }
    const statusResults = await statusPipeline.exec();
    if (!statusResults) return 0;

    let purged = 0;

    // Delete each candidate whose status matches
    for (let i = 0; i < candidateIds.length; i++) {
      const [err, status] = statusResults[i];
      if (err) continue;
      if (typeof status === "string" && statusSet.has(status as RunStatus)) {
        await this.removeRun(candidateIds[i]);
        purged++;
      }
    }

    return purged;
  }

  // ---------------------------------------------------------------------------
  // Step methods
  // ---------------------------------------------------------------------------

  async addStep(step: Step): Promise<void> {
    const hash = stepToHash(step);
    const pipeline = this.redis.multi();

    pipeline.hset(stepHashKey(this.prefix, step.id), hash);
    pipeline.sadd(runStepsKey(this.prefix, step.runId), step.id);

    await pipeline.exec();
  }

  async updateStep(id: string, patch: StepPatch): Promise<void> {
    const { setArgs, delFields } = patchToHashArgs(
      patch as Record<string, unknown>,
      STEP_DATE_FIELDS,
      new Set<string>(), // Steps have no number fields to convert
      STEP_PATCH_KEYS,
    );

    if (Object.keys(setArgs).length === 0 && delFields.length === 0) return;

    const pipeline = this.redis.multi();

    if (Object.keys(setArgs).length > 0) {
      pipeline.hset(stepHashKey(this.prefix, id), setArgs);
    }
    if (delFields.length > 0) {
      pipeline.hdel(stepHashKey(this.prefix, id), ...delFields);
    }

    await pipeline.exec();
  }

  async getSteps(runId: string): Promise<Step[]> {
    const stepIds = await this.redis.smembers(runStepsKey(this.prefix, runId));
    if (stepIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const stepId of stepIds) {
      pipeline.hgetall(stepHashKey(this.prefix, stepId));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const steps: Step[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (data && Object.keys(data).length > 0) {
        steps.push(hashToStep(data));
      }
    }
    return steps;
  }

  async removeSteps(runId: string): Promise<void> {
    const stepIds = await this.redis.smembers(runStepsKey(this.prefix, runId));
    if (stepIds.length === 0) return;

    const pipeline = this.redis.multi();
    for (const stepId of stepIds) {
      pipeline.del(stepHashKey(this.prefix, stepId));
    }
    pipeline.del(runStepsKey(this.prefix, runId));

    await pipeline.exec();
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.redis.ping();
      return response === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.ownsConnection) {
      await this.redis.quit();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Fetch multiple runs by ID using a pipeline. Preserves input order, skips missing. */
  private async fetchRunsByIds(ids: string[]): Promise<Run[]> {
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(runHashKey(this.prefix, id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const runs: Run[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (data && Object.keys(data).length > 0) {
        runs.push(hashToRun(data));
      }
    }
    return runs;
  }
}

/**
 * Apply status filter + offset/limit to an already-newest-first run list.
 * Redis has no per-signal status-ordered index, so the status filter is a
 * post-fetch pass — acceptable for the dashboard's bounded listings.
 */
function applyRunListOptions(runs: Run[], options: ListRunsOptions): Run[] {
  let out = runs;
  if (options.statuses && options.statuses.length > 0) {
    const set = new Set(options.statuses);
    out = out.filter((run) => set.has(run.status));
  }
  const offset = options.offset ?? 0;
  if (offset > 0) out = out.slice(offset);
  if (options.limit !== undefined && options.limit >= 0) out = out.slice(0, options.limit);
  return out;
}

// Register in the adapter factory for cross-process reconstruction
registerAdapter("redis", (options: Record<string, unknown>) => new RedisAdapter(options as RedisAdapterOptions));

export { BroadcastRedisAdapter, type BroadcastRedisAdapterOptions } from "./broadcast.js";
