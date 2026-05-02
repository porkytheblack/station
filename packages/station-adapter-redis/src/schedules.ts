import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type {
  Schedule,
  SchedulePatch,
  ScheduleAdapter,
  ScheduleListFilter,
} from "station-schedules";
import {
  scheduleHashKey,
  scheduleDueKey,
  scheduleAllKey,
  scheduleByKindKey,
} from "./shared.js";

export interface ScheduleRedisAdapterOptions {
  url?: string;
  redis?: Redis;
  prefix?: string;
}

const SCHEDULE_DATE_FIELDS = new Set(["nextRunAt", "lastRunAt", "createdAt", "updatedAt"]);

export class ScheduleRedisAdapter implements ScheduleAdapter {
  private redis: Redis;
  private prefix: string;
  private ownsConnection: boolean;

  constructor(options: ScheduleRedisAdapterOptions = {}) {
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

  async add(schedule: Schedule): Promise<void> {
    const hash = scheduleToHash(schedule);
    const pipeline = this.redis.multi();
    pipeline.hset(scheduleHashKey(this.prefix, schedule.id), hash);
    pipeline.sadd(scheduleAllKey(this.prefix), schedule.id);
    pipeline.sadd(scheduleByKindKey(this.prefix, schedule.kind), schedule.id);
    if (schedule.enabled) {
      pipeline.zadd(scheduleDueKey(this.prefix), String(schedule.nextRunAt.getTime()), schedule.id);
    }
    await pipeline.exec();
  }

  async get(id: string): Promise<Schedule | null> {
    const hash = await this.redis.hgetall(scheduleHashKey(this.prefix, id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToSchedule(hash);
  }

  async list(filter?: ScheduleListFilter): Promise<Schedule[]> {
    let ids: string[];
    if (filter?.due) {
      const now = Date.now();
      ids = await this.redis.zrangebyscore(scheduleDueKey(this.prefix), "-inf", String(now));
    } else if (filter?.kind) {
      ids = await this.redis.smembers(scheduleByKindKey(this.prefix, filter.kind));
    } else {
      ids = await this.redis.smembers(scheduleAllKey(this.prefix));
    }
    if (ids.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(scheduleHashKey(this.prefix, id));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: Schedule[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (!data || Object.keys(data).length === 0) continue;
      const schedule = hashToSchedule(data);
      if (filter?.kind && schedule.kind !== filter.kind) continue;
      if (filter?.enabled !== undefined && schedule.enabled !== filter.enabled) continue;
      if (filter?.due && !schedule.enabled) continue;
      out.push(schedule);
    }
    out.sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime());
    return out;
  }

  async update(id: string, patch: SchedulePatch): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;

    const pipeline = this.redis.multi();
    const setArgs: Record<string, string> = {};
    const delFields: string[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (key === "input") {
        if (value === undefined) delFields.push("input");
        else setArgs.input = JSON.stringify(value);
      } else if (key === "enabled") {
        setArgs.enabled = value ? "1" : "0";
      } else if (SCHEDULE_DATE_FIELDS.has(key)) {
        if (value instanceof Date) setArgs[key] = value.toISOString();
        else if (value === undefined) delFields.push(key);
      } else if (key === "interval" || key === "lastRunStatus" || key === "lastRunId" || key === "createdBy") {
        if (value === undefined) delFields.push(key);
        else setArgs[key] = String(value);
      }
    }

    if (!("updatedAt" in patch)) {
      setArgs.updatedAt = new Date().toISOString();
    }

    if (Object.keys(setArgs).length > 0) {
      pipeline.hset(scheduleHashKey(this.prefix, id), setArgs);
    }
    if (delFields.length > 0) {
      pipeline.hdel(scheduleHashKey(this.prefix, id), ...delFields);
    }

    // Reindex the due-set when nextRunAt or enabled changes.
    const newEnabled = patch.enabled ?? existing.enabled;
    const newNext = patch.nextRunAt ?? existing.nextRunAt;
    if (patch.enabled !== undefined || patch.nextRunAt !== undefined) {
      pipeline.zrem(scheduleDueKey(this.prefix), id);
      if (newEnabled) {
        pipeline.zadd(scheduleDueKey(this.prefix), String(newNext.getTime()), id);
      }
    }

    await pipeline.exec();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    const pipeline = this.redis.multi();
    pipeline.del(scheduleHashKey(this.prefix, id));
    pipeline.srem(scheduleAllKey(this.prefix), id);
    pipeline.srem(scheduleByKindKey(this.prefix, existing.kind), id);
    pipeline.zrem(scheduleDueKey(this.prefix), id);
    await pipeline.exec();
    return true;
  }

  /**
   * Atomic claim using a Lua script — Redis runs scripts atomically, so two
   * runners can't both claim the same schedule. Each script call advances
   * `nextRunAt` only if the stored value matches `expectedNextRunAt`.
   */
  async claimDue(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean> {
    const result = (await this.redis.eval(
      CLAIM_LUA,
      2,
      scheduleHashKey(this.prefix, id),
      scheduleDueKey(this.prefix),
      id,
      String(expectedNextRunAt.getTime()),
      newNextRunAt.toISOString(),
      String(newNextRunAt.getTime()),
      new Date().toISOString(),
    )) as number;
    return result === 1;
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.redis.ping();
      return r === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.ownsConnection) {
      await this.redis.quit();
    }
  }
}

const CLAIM_LUA = `
local hash_key = KEYS[1]
local due_key = KEYS[2]
local id = ARGV[1]
local expected_ms = tonumber(ARGV[2])
local new_iso = ARGV[3]
local new_ms = tonumber(ARGV[4])
local now_iso = ARGV[5]

local current_iso = redis.call('HGET', hash_key, 'nextRunAt')
local enabled = redis.call('HGET', hash_key, 'enabled')
if not current_iso or enabled ~= '1' then return 0 end
-- Convert ISO to ms for compare. We stored both the ISO string in the hash
-- and the timestamp as the score in the due-set; compare via the score
-- (cheaper and guaranteed numeric).
local score = redis.call('ZSCORE', due_key, id)
if not score or tonumber(score) ~= expected_ms then return 0 end

redis.call('HSET', hash_key, 'nextRunAt', new_iso, 'updatedAt', now_iso)
redis.call('ZADD', due_key, new_ms, id)
return 1
`;

function scheduleToHash(s: Schedule): Record<string, string> {
  const hash: Record<string, string> = {
    id: s.id,
    kind: s.kind,
    target: s.target,
    interval: s.interval,
    enabled: s.enabled ? "1" : "0",
    nextRunAt: s.nextRunAt.toISOString(),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
  if (s.input !== undefined) hash.input = JSON.stringify(s.input);
  if (s.lastRunAt) hash.lastRunAt = s.lastRunAt.toISOString();
  if (s.lastRunStatus) hash.lastRunStatus = s.lastRunStatus;
  if (s.lastRunId) hash.lastRunId = s.lastRunId;
  if (s.createdBy) hash.createdBy = s.createdBy;
  return hash;
}

function hashToSchedule(hash: Record<string, string>): Schedule {
  return {
    id: hash.id,
    kind: hash.kind as Schedule["kind"],
    target: hash.target,
    interval: hash.interval,
    input: hash.input ? JSON.parse(hash.input) : undefined,
    enabled: hash.enabled === "1",
    nextRunAt: new Date(hash.nextRunAt),
    lastRunAt: hash.lastRunAt ? new Date(hash.lastRunAt) : undefined,
    lastRunStatus: hash.lastRunStatus,
    lastRunId: hash.lastRunId,
    createdAt: new Date(hash.createdAt),
    updatedAt: new Date(hash.updatedAt),
    createdBy: hash.createdBy,
  };
}
