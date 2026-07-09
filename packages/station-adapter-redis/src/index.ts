import { randomUUID } from "node:crypto";
import Redis from "ioredis";
export type { Redis } from "ioredis";
import type { SerializableAdapter, AdapterManifest, ListAllRunsOptions, ListRunsOptions, Run, RunPatch, RunStatus, Step, StepPatch } from "station-signal";
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

    const pipeline = this.redis.multi();

    // Store run data as a hash
    pipeline.hset(hashKey, hash);

    // Index by status
    if (run.status === "pending") {
      pipeline.zadd(pendingRunsKey(this.prefix), String(dateToScore(run.nextRunAt)), run.id);
    } else if (run.status === "running") {
      pipeline.zadd(runningRunsKey(this.prefix), String(dateToScore(run.startedAt)), run.id);
    }

    // Index by signal name (score = createdAt timestamp for ordering)
    pipeline.zadd(signalRunsKey(this.prefix, run.signalName), String(run.createdAt.getTime()), run.id);

    // Track the signal name so listAllRuns/countRunsByStatus can enumerate
    // signals. Forward-populated: runs written by older versions are still
    // reachable via listRuns(name); they just won't appear in cross-signal
    // queries until a new run for that signal is added.
    pipeline.sadd(signalNamesKey(this.prefix), run.signalName);

    // Index by signal name + status (set for hasRunWithStatus)
    pipeline.sadd(statusRunsKey(this.prefix, run.signalName, run.status), run.id);

    // Track completedAt for purge support
    if (run.completedAt) {
      pipeline.zadd(completedAtRunsKey(this.prefix), String(run.completedAt.getTime()), run.id);
    }

    await pipeline.exec();
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
