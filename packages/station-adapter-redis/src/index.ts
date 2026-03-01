import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type { SerializableAdapter, AdapterManifest, Run, RunPatch, RunStatus, Step, StepPatch } from "station-signal";
import { registerAdapter } from "station-signal";

import {
  runHashKey,
  pendingRunsKey,
  runningRunsKey,
  signalRunsKey,
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
  RUN_PATCH_KEYS,
  STEP_PATCH_KEYS,
  RUN_DATE_FIELDS,
  RUN_NUMBER_FIELDS,
  STEP_DATE_FIELDS,
} from "./shared.js";

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

  async getRunsDue(): Promise<Run[]> {
    const now = Date.now();
    const ids = await this.redis.zrangebyscore(pendingRunsKey(this.prefix), "-inf", String(now));
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

    const pipeline = this.redis.multi();

    // Update hash fields
    if (Object.keys(setArgs).length > 0) {
      pipeline.hset(runHashKey(this.prefix, id), setArgs);
    }

    // Remove deleted fields from hash
    if (delFields.length > 0) {
      pipeline.hdel(runHashKey(this.prefix, id), ...delFields);
    }

    // Handle status transitions
    const newStatus = patch.status;
    if (newStatus !== undefined && newStatus !== currentRun.status) {
      // Remove from old status index set
      pipeline.srem(statusRunsKey(this.prefix, currentRun.signalName, currentRun.status), id);
      // Add to new status index set
      pipeline.sadd(statusRunsKey(this.prefix, currentRun.signalName, newStatus), id);

      // Remove from old scheduling sorted set
      if (currentRun.status === "pending") {
        pipeline.zrem(pendingRunsKey(this.prefix), id);
      } else if (currentRun.status === "running") {
        pipeline.zrem(runningRunsKey(this.prefix), id);
      }

      // Add to new scheduling sorted set
      if (newStatus === "pending") {
        const nextRunAt = patch.nextRunAt ?? currentRun.nextRunAt;
        pipeline.zadd(pendingRunsKey(this.prefix), String(dateToScore(nextRunAt)), id);
      } else if (newStatus === "running") {
        const startedAt = patch.startedAt ?? currentRun.startedAt;
        pipeline.zadd(runningRunsKey(this.prefix), String(dateToScore(startedAt)), id);
      }
    } else if (newStatus === undefined || newStatus === currentRun.status) {
      // Status unchanged — but nextRunAt may have changed for a pending run
      if (currentRun.status === "pending" && patch.nextRunAt !== undefined) {
        pipeline.zadd(pendingRunsKey(this.prefix), String(dateToScore(patch.nextRunAt)), id);
      }
    }

    // Track completedAt for purge
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) {
        pipeline.zrem(completedAtRunsKey(this.prefix), id);
      } else {
        pipeline.zadd(completedAtRunsKey(this.prefix), String((patch.completedAt as Date).getTime()), id);
      }
    }

    await pipeline.exec();
  }

  async listRuns(signalName: string): Promise<Run[]> {
    // ZREVRANGE returns IDs ordered by createdAt descending
    const ids = await this.redis.zrevrange(signalRunsKey(this.prefix, signalName), 0, -1);
    if (ids.length === 0) return [];

    return this.fetchRunsByIds(ids);
  }

  async hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;

    // Check each status set — return true as soon as one is non-empty
    for (const status of statuses) {
      const count = await this.redis.scard(statusRunsKey(this.prefix, signalName, status));
      if (count > 0) return true;
    }
    return false;
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

    let purged = 0;

    // Check each candidate's status and delete if it matches
    for (const id of candidateIds) {
      const status = await this.redis.hget(runHashKey(this.prefix, id), "status");
      if (status && statusSet.has(status as RunStatus)) {
        await this.removeRun(id);
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

// Register in the adapter factory for cross-process reconstruction
registerAdapter("redis", (options: Record<string, unknown>) => new RedisAdapter(options as RedisAdapterOptions));

export { BroadcastRedisAdapter, type BroadcastRedisAdapterOptions } from "./broadcast.js";
