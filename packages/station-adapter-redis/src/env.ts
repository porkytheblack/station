import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type {
  EnvVar,
  EnvVarPatch,
  EnvStorageAdapter,
  EnvTarget,
} from "station-env";
import { envVarHashKey, envVarAllKey } from "./shared.js";

export interface EnvRedisAdapterOptions {
  url?: string;
  redis?: Redis;
  prefix?: string;
}

/** Durable {@link EnvStorageAdapter} backed by Redis (ioredis). */
export class EnvRedisAdapter implements EnvStorageAdapter {
  private redis: Redis;
  private prefix: string;
  private ownsConnection: boolean;

  constructor(options: EnvRedisAdapterOptions = {}) {
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

  async add(envVar: EnvVar): Promise<void> {
    const exists = await this.redis.exists(envVarHashKey(this.prefix, envVar.id));
    if (exists) {
      throw new Error(`Env var with id "${envVar.id}" already exists`);
    }
    const pipeline = this.redis.multi();
    pipeline.hset(envVarHashKey(this.prefix, envVar.id), envVarToHash(envVar));
    pipeline.sadd(envVarAllKey(this.prefix), envVar.id);
    await pipeline.exec();
  }

  async get(id: string): Promise<EnvVar | null> {
    const hash = await this.redis.hgetall(envVarHashKey(this.prefix, id));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToEnvVar(hash);
  }

  async list(): Promise<EnvVar[]> {
    const ids = await this.redis.smembers(envVarAllKey(this.prefix));
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(envVarHashKey(this.prefix, id));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: EnvVar[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (!data || Object.keys(data).length === 0) continue;
      out.push(hashToEnvVar(data));
    }
    out.sort((a, b) => a.key.localeCompare(b.key) || a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async update(id: string, patch: EnvVarPatch): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;

    const setArgs: Record<string, string> = {};
    const delFields: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === "value") {
        if (value !== undefined) setArgs.value = String(value);
      } else if (key === "secret") {
        if (value !== undefined) setArgs.secret = value ? "1" : "0";
      } else if (key === "targets") {
        // Treat an explicit `undefined` as "leave unchanged" — EnvStore.update
        // sends targets on every call, so writing "[]" here would silently
        // reset a scoped variable to global (a secret scope escalation).
        if (value !== undefined) setArgs.targets = JSON.stringify(value);
      } else if (key === "updatedAt") {
        if (value instanceof Date) setArgs.updatedAt = value.toISOString();
      } else if (key === "createdBy") {
        if (value === undefined) delFields.push("createdBy");
        else setArgs.createdBy = String(value);
      }
    }
    if (!("updatedAt" in patch)) {
      setArgs.updatedAt = new Date().toISOString();
    }

    const pipeline = this.redis.multi();
    if (Object.keys(setArgs).length > 0) {
      pipeline.hset(envVarHashKey(this.prefix, id), setArgs);
    }
    if (delFields.length > 0) {
      pipeline.hdel(envVarHashKey(this.prefix, id), ...delFields);
    }
    await pipeline.exec();
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    const pipeline = this.redis.multi();
    pipeline.del(envVarHashKey(this.prefix, id));
    pipeline.srem(envVarAllKey(this.prefix), id);
    await pipeline.exec();
    return true;
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

function envVarToHash(v: EnvVar): Record<string, string> {
  const hash: Record<string, string> = {
    id: v.id,
    key: v.key,
    value: v.value,
    secret: v.secret ? "1" : "0",
    targets: JSON.stringify(v.targets ?? []),
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
  if (v.createdBy) hash.createdBy = v.createdBy;
  return hash;
}

function hashToEnvVar(hash: Record<string, string>): EnvVar {
  return {
    id: hash.id,
    key: hash.key,
    value: hash.value,
    secret: hash.secret === "1",
    targets: parseTargets(hash.targets),
    createdAt: new Date(hash.createdAt),
    updatedAt: new Date(hash.updatedAt),
    createdBy: hash.createdBy,
  };
}

function parseTargets(raw: unknown): EnvTarget[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
