import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type {
  BroadcastQueueAdapter,
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
  DynamicBroadcastSpec,
} from "station-broadcast";

import {
  broadcastRunHashKey,
  pendingBroadcastRunsKey,
  runningBroadcastRunsKey,
  broadcastNameRunsKey,
  broadcastStatusRunsKey,
  completedAtBroadcastRunsKey,
  nodeRunHashKey,
  broadcastRunNodesKey,
  broadcastRunToHash,
  hashToBroadcastRun,
  nodeRunToHash,
  hashToNodeRun,
  dateToScore,
  patchToHashArgs,
  BROADCAST_RUN_PATCH_KEYS,
  NODE_RUN_PATCH_KEYS,
  BROADCAST_RUN_DATE_FIELDS,
  BROADCAST_RUN_NUMBER_FIELDS,
  NODE_RUN_DATE_FIELDS,
  broadcastDefinitionKey,
  broadcastDefinitionVersionsKey,
  broadcastDefinitionNamesKey,
  broadcastDefinitionCounterKey,
} from "./shared.js";

export interface BroadcastRedisAdapterOptions {
  /** Redis connection URL. Defaults to "redis://localhost:6379". */
  url?: string;
  /** Existing ioredis instance. Takes precedence over `url` if provided. */
  redis?: Redis;
  /** Key prefix for all Redis keys. Defaults to "station". */
  prefix?: string;
}

export class BroadcastRedisAdapter implements BroadcastQueueAdapter {
  private redis: Redis;
  private prefix: string;
  private ownsConnection: boolean;

  constructor(options: BroadcastRedisAdapterOptions = {}) {
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

  // ---------------------------------------------------------------------------
  // Broadcast run methods
  // ---------------------------------------------------------------------------

  async addBroadcastRun(run: BroadcastRun): Promise<void> {
    const hash = broadcastRunToHash(run);
    const hashKey = broadcastRunHashKey(this.prefix, run.id);

    const pipeline = this.redis.multi();

    // Store run data as a hash
    pipeline.hset(hashKey, hash);

    // Index by status for scheduling
    if (run.status === "pending") {
      pipeline.zadd(pendingBroadcastRunsKey(this.prefix), String(dateToScore(run.nextRunAt)), run.id);
    } else if (run.status === "running") {
      pipeline.zadd(runningBroadcastRunsKey(this.prefix), String(dateToScore(run.startedAt)), run.id);
    }

    // Index by broadcast name (score = createdAt timestamp)
    pipeline.zadd(broadcastNameRunsKey(this.prefix, run.broadcastName), String(run.createdAt.getTime()), run.id);

    // Index by broadcast name + status (set for hasBroadcastRunWithStatus)
    pipeline.sadd(broadcastStatusRunsKey(this.prefix, run.broadcastName, run.status), run.id);

    // Track completedAt for purge support
    if (run.completedAt) {
      pipeline.zadd(completedAtBroadcastRunsKey(this.prefix), String(run.completedAt.getTime()), run.id);
    }

    await pipeline.exec();
  }

  async getBroadcastRun(id: string): Promise<BroadcastRun | null> {
    const hash = await this.redis.hgetall(broadcastRunHashKey(this.prefix, id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToBroadcastRun(hash);
  }

  async updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void> {
    const currentRun = await this.getBroadcastRun(id);
    if (!currentRun) return;

    const { setArgs, delFields } = patchToHashArgs(
      patch as Record<string, unknown>,
      BROADCAST_RUN_DATE_FIELDS,
      BROADCAST_RUN_NUMBER_FIELDS,
      BROADCAST_RUN_PATCH_KEYS,
    );

    if (Object.keys(setArgs).length === 0 && delFields.length === 0) return;

    const pipeline = this.redis.multi();

    // Update hash fields
    if (Object.keys(setArgs).length > 0) {
      pipeline.hset(broadcastRunHashKey(this.prefix, id), setArgs);
    }

    // Remove deleted fields from hash
    if (delFields.length > 0) {
      pipeline.hdel(broadcastRunHashKey(this.prefix, id), ...delFields);
    }

    // Handle status transitions
    const newStatus = patch.status;
    if (newStatus !== undefined && newStatus !== currentRun.status) {
      // Remove from old status index set
      pipeline.srem(broadcastStatusRunsKey(this.prefix, currentRun.broadcastName, currentRun.status), id);
      // Add to new status index set
      pipeline.sadd(broadcastStatusRunsKey(this.prefix, currentRun.broadcastName, newStatus), id);

      // Remove from old scheduling sorted set
      if (currentRun.status === "pending") {
        pipeline.zrem(pendingBroadcastRunsKey(this.prefix), id);
      } else if (currentRun.status === "running") {
        pipeline.zrem(runningBroadcastRunsKey(this.prefix), id);
      }

      // Add to new scheduling sorted set
      if (newStatus === "pending") {
        const nextRunAt = patch.nextRunAt ?? currentRun.nextRunAt;
        pipeline.zadd(pendingBroadcastRunsKey(this.prefix), String(dateToScore(nextRunAt)), id);
      } else if (newStatus === "running") {
        const startedAt = patch.startedAt ?? currentRun.startedAt;
        pipeline.zadd(runningBroadcastRunsKey(this.prefix), String(dateToScore(startedAt)), id);
      }
    } else if (newStatus === undefined || newStatus === currentRun.status) {
      // Status unchanged — but nextRunAt may have changed for a pending run
      if (currentRun.status === "pending" && patch.nextRunAt !== undefined) {
        pipeline.zadd(pendingBroadcastRunsKey(this.prefix), String(dateToScore(patch.nextRunAt)), id);
      }
    }

    // Track completedAt for purge
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) {
        pipeline.zrem(completedAtBroadcastRunsKey(this.prefix), id);
      } else {
        pipeline.zadd(completedAtBroadcastRunsKey(this.prefix), String((patch.completedAt as Date).getTime()), id);
      }
    }

    await pipeline.exec();
  }

  async getBroadcastRunsDue(): Promise<BroadcastRun[]> {
    const now = Date.now();
    const ids = await this.redis.zrangebyscore(pendingBroadcastRunsKey(this.prefix), "-inf", String(now));
    if (ids.length === 0) return [];

    return this.fetchBroadcastRunsByIds(ids);
  }

  async getBroadcastRunsRunning(): Promise<BroadcastRun[]> {
    const ids = await this.redis.zrange(runningBroadcastRunsKey(this.prefix), 0, -1);
    if (ids.length === 0) return [];

    return this.fetchBroadcastRunsByIds(ids);
  }

  async listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]> {
    const ids = await this.redis.zrevrange(broadcastNameRunsKey(this.prefix, broadcastName), 0, -1);
    if (ids.length === 0) return [];

    return this.fetchBroadcastRunsByIds(ids);
  }

  async hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;

    for (const status of statuses) {
      const count = await this.redis.scard(broadcastStatusRunsKey(this.prefix, broadcastName, status));
      if (count > 0) return true;
    }
    return false;
  }

  async purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;

    const statusSet = new Set(statuses);
    const cutoff = olderThan.getTime();

    // Get all broadcast run IDs with completedAt before the cutoff
    const candidateIds = await this.redis.zrangebyscore(
      completedAtBroadcastRunsKey(this.prefix),
      "-inf",
      String(cutoff - 1),
    );

    if (candidateIds.length === 0) return 0;

    let purged = 0;

    for (const id of candidateIds) {
      const status = await this.redis.hget(broadcastRunHashKey(this.prefix, id), "status");
      if (status && statusSet.has(status as BroadcastRunStatus)) {
        await this.removeBroadcastRun(id);
        purged++;
      }
    }

    return purged;
  }

  // ---------------------------------------------------------------------------
  // Node run methods
  // ---------------------------------------------------------------------------

  async addNodeRun(nodeRun: BroadcastNodeRun): Promise<void> {
    const hash = nodeRunToHash(nodeRun);
    const pipeline = this.redis.multi();

    pipeline.hset(nodeRunHashKey(this.prefix, nodeRun.id), hash);
    pipeline.sadd(broadcastRunNodesKey(this.prefix, nodeRun.broadcastRunId), nodeRun.id);

    await pipeline.exec();
  }

  async getNodeRun(id: string): Promise<BroadcastNodeRun | null> {
    const hash = await this.redis.hgetall(nodeRunHashKey(this.prefix, id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToNodeRun(hash);
  }

  async updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void> {
    const { setArgs, delFields } = patchToHashArgs(
      patch as Record<string, unknown>,
      NODE_RUN_DATE_FIELDS,
      new Set<string>(), // Node runs have no numeric fields to convert
      NODE_RUN_PATCH_KEYS,
    );

    if (Object.keys(setArgs).length === 0 && delFields.length === 0) return;

    const pipeline = this.redis.multi();

    if (Object.keys(setArgs).length > 0) {
      pipeline.hset(nodeRunHashKey(this.prefix, id), setArgs);
    }
    if (delFields.length > 0) {
      pipeline.hdel(nodeRunHashKey(this.prefix, id), ...delFields);
    }

    await pipeline.exec();
  }

  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]> {
    const nodeIds = await this.redis.smembers(broadcastRunNodesKey(this.prefix, broadcastRunId));
    if (nodeIds.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const nodeId of nodeIds) {
      pipeline.hgetall(nodeRunHashKey(this.prefix, nodeId));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const nodeRuns: BroadcastNodeRun[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (data && Object.keys(data).length > 0) {
        nodeRuns.push(hashToNodeRun(data));
      }
    }
    return nodeRuns;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Dynamic broadcast definitions
  // ---------------------------------------------------------------------------

  async saveDefinition(spec: DynamicBroadcastSpec): Promise<DynamicBroadcastSpec> {
    const versionsKey = broadcastDefinitionVersionsKey(this.prefix, spec.name);
    const namesKey = broadcastDefinitionNamesKey(this.prefix);
    const deletedKey = this.deletedFlagKey();
    const counterKey = broadcastDefinitionCounterKey(this.prefix, spec.name);

    // Atomic version bump. The Lua script seeds the counter from the existing
    // zset on first call (so an upgrade from a pre-counter installation
    // doesn't reuse old versions), then INCRs. Concurrent callers always
    // observe distinct values.
    const nextVersion = (await this.redis.eval(
      BUMP_VERSION_LUA,
      2,
      counterKey,
      versionsKey,
    )) as number;

    const now = new Date();
    const next: DynamicBroadcastSpec = {
      ...spec,
      version: nextVersion,
      createdAt: spec.createdAt ?? now,
      updatedAt: now,
      deletedAt: undefined,
    };
    const pipeline = this.redis.multi();
    pipeline.set(broadcastDefinitionKey(this.prefix, spec.name, nextVersion), JSON.stringify(next));
    pipeline.zadd(versionsKey, String(nextVersion), String(nextVersion));
    pipeline.sadd(namesKey, spec.name);
    pipeline.hdel(deletedKey, spec.name);
    await pipeline.exec();
    return next;
  }

  async getDefinition(name: string, version?: number): Promise<DynamicBroadcastSpec | null> {
    if (version !== undefined) {
      const json = await this.redis.get(broadcastDefinitionKey(this.prefix, name, version));
      return json ? deserializeSpec(json) : null;
    }
    const top = await this.redis.zrevrange(broadcastDefinitionVersionsKey(this.prefix, name), 0, 0);
    if (top.length === 0) return null;
    const json = await this.redis.get(broadcastDefinitionKey(this.prefix, name, Number(top[0])));
    return json ? deserializeSpec(json) : null;
  }

  async listDefinitions(): Promise<DynamicBroadcastSpec[]> {
    const names = await this.redis.smembers(broadcastDefinitionNamesKey(this.prefix));
    if (names.length === 0) return [];
    const deletedFlags = await this.redis.hmget(this.deletedFlagKey(), ...names);
    const out: DynamicBroadcastSpec[] = [];
    for (let i = 0; i < names.length; i++) {
      if (deletedFlags[i] === "1") continue;
      const latest = await this.getDefinition(names[i]);
      if (latest) out.push(latest);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async listDefinitionVersions(name: string): Promise<DynamicBroadcastSpec[]> {
    const versions = await this.redis.zrevrange(
      broadcastDefinitionVersionsKey(this.prefix, name),
      0,
      -1,
    );
    if (versions.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const v of versions) {
      pipeline.get(broadcastDefinitionKey(this.prefix, name, Number(v)));
    }
    const results = await pipeline.exec();
    if (!results) return [];
    const specs: DynamicBroadcastSpec[] = [];
    for (const [err, json] of results) {
      if (err || typeof json !== "string") continue;
      specs.push(deserializeSpec(json));
    }
    return specs;
  }

  async deleteDefinition(name: string): Promise<boolean> {
    const top = await this.redis.zrevrange(broadcastDefinitionVersionsKey(this.prefix, name), 0, 0);
    if (top.length === 0) return false;
    const isDeleted = await this.redis.hget(this.deletedFlagKey(), name);
    if (isDeleted === "1") return false;
    // Update the latest version's spec with deletedAt for inspection,
    // then mark the name as deleted so listDefinitions filters it out.
    const version = Number(top[0]);
    const latestKey = broadcastDefinitionKey(this.prefix, name, version);
    const json = await this.redis.get(latestKey);
    if (!json) return false;
    const spec = deserializeSpec(json);
    spec.deletedAt = new Date();
    const pipeline = this.redis.multi();
    pipeline.set(latestKey, JSON.stringify(spec));
    pipeline.hset(this.deletedFlagKey(), name, "1");
    await pipeline.exec();
    return true;
  }

  /** Single hash storing soft-delete flags by definition name. */
  private deletedFlagKey(): string {
    return `${this.prefix}:broadcast-defs:deleted`;
  }

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

  /** Fetch multiple broadcast runs by ID using a pipeline. Preserves order, skips missing. */
  private async fetchBroadcastRunsByIds(ids: string[]): Promise<BroadcastRun[]> {
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(broadcastRunHashKey(this.prefix, id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const runs: BroadcastRun[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (data && Object.keys(data).length > 0) {
        runs.push(hashToBroadcastRun(data));
      }
    }
    return runs;
  }

  /**
   * Remove a broadcast run and all associated node runs and index entries.
   * Used internally by purgeBroadcastRuns.
   */
  private async removeBroadcastRun(id: string): Promise<void> {
    const run = await this.getBroadcastRun(id);
    if (!run) return;

    // Get all node run IDs for this broadcast run
    const nodeIds = await this.redis.smembers(broadcastRunNodesKey(this.prefix, id));

    const pipeline = this.redis.multi();

    // Delete the broadcast run hash
    pipeline.del(broadcastRunHashKey(this.prefix, id));

    // Remove from scheduling sorted sets
    pipeline.zrem(pendingBroadcastRunsKey(this.prefix), id);
    pipeline.zrem(runningBroadcastRunsKey(this.prefix), id);

    // Remove from broadcast name index
    pipeline.zrem(broadcastNameRunsKey(this.prefix, run.broadcastName), id);

    // Remove from status set
    pipeline.srem(broadcastStatusRunsKey(this.prefix, run.broadcastName, run.status), id);

    // Remove from completed-at index
    pipeline.zrem(completedAtBroadcastRunsKey(this.prefix), id);

    // Delete all node run hashes
    for (const nodeId of nodeIds) {
      pipeline.del(nodeRunHashKey(this.prefix, nodeId));
    }

    // Delete the node runs index set
    pipeline.del(broadcastRunNodesKey(this.prefix, id));

    await pipeline.exec();
  }
}

function deserializeSpec(json: string): DynamicBroadcastSpec {
  const obj = JSON.parse(json) as DynamicBroadcastSpec;
  if (obj.createdAt) obj.createdAt = new Date(obj.createdAt);
  if (obj.updatedAt) obj.updatedAt = new Date(obj.updatedAt);
  if (obj.deletedAt) obj.deletedAt = new Date(obj.deletedAt);
  return obj;
}

const BUMP_VERSION_LUA = `
local counterKey = KEYS[1]
local versionsKey = KEYS[2]
local exists = redis.call('EXISTS', counterKey)
if exists == 0 then
  local top = redis.call('ZREVRANGE', versionsKey, 0, 0, 'WITHSCORES')
  local seed = 0
  if #top == 2 then seed = tonumber(top[2]) end
  redis.call('SET', counterKey, seed)
end
return redis.call('INCR', counterKey)
`;

