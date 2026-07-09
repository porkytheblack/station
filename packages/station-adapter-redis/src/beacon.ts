import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type {
  BeaconStateAdapter,
  BeaconInstance,
  BeaconInstancePatch,
  BeaconEvent,
} from "station-beacon";
import { key, patchToHashArgs } from "./shared.js";

export interface BeaconRedisAdapterOptions {
  url?: string;
  redis?: Redis;
  prefix?: string;
  /** Max lifecycle events retained per beacon. @default 1000 */
  maxEventsPerBeacon?: number;
}

const beaconHashKey = (prefix: string, name: string) => key(prefix, "beacon", name);
const beaconAllKey = (prefix: string) => key(prefix, "beacons", "all");
const beaconEventsKey = (prefix: string, name: string) => key(prefix, "beacon-events", name);

const BEACON_DATE_FIELDS = new Set([
  "startedAt", "readyAt", "lastHeartbeatAt", "lastExitAt", "nextRestartAt", "createdAt", "updatedAt",
]);
const BEACON_NUMBER_FIELDS = new Set(["incarnation", "restartCount", "pid"]);
const BEACON_PATCH_KEYS = new Set([
  "status", "desiredState", "incarnation", "restartCount", "pid", "config",
  "startedAt", "readyAt", "lastHeartbeatAt", "lastExitAt", "lastExitReason",
  "lastError", "nextRestartAt", "updatedAt",
]);

/** Durable {@link BeaconStateAdapter} backed by Redis (ioredis). */
export class BeaconRedisAdapter implements BeaconStateAdapter {
  private redis: Redis;
  private prefix: string;
  private ownsConnection: boolean;
  private maxEvents: number;

  constructor(options: BeaconRedisAdapterOptions = {}) {
    this.prefix = options.prefix ?? "station";
    this.maxEvents = options.maxEventsPerBeacon ?? 1000;
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

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    const hash = instanceToHash(instance);
    const k = beaconHashKey(this.prefix, instance.beaconName);
    // DEL + HSET fully replaces so a field that became undefined doesn't linger.
    const pipeline = this.redis.multi();
    pipeline.del(k);
    pipeline.hset(k, hash);
    pipeline.sadd(beaconAllKey(this.prefix), instance.beaconName);
    await pipeline.exec();
  }

  async getInstance(beaconName: string): Promise<BeaconInstance | null> {
    const hash = await this.redis.hgetall(beaconHashKey(this.prefix, beaconName));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToInstance(hash);
  }

  async updateInstance(beaconName: string, patch: BeaconInstancePatch): Promise<void> {
    const exists = await this.redis.exists(beaconHashKey(this.prefix, beaconName));
    if (!exists) return;
    const { setArgs, delFields } = patchToHashArgs(
      patch as Record<string, unknown>,
      BEACON_DATE_FIELDS,
      BEACON_NUMBER_FIELDS,
      BEACON_PATCH_KEYS,
    );
    if (!("updatedAt" in patch)) {
      setArgs.updatedAt = new Date().toISOString();
    }
    const k = beaconHashKey(this.prefix, beaconName);
    const pipeline = this.redis.multi();
    if (Object.keys(setArgs).length > 0) pipeline.hset(k, setArgs);
    if (delFields.length > 0) pipeline.hdel(k, ...delFields);
    await pipeline.exec();
  }

  async listInstances(): Promise<BeaconInstance[]> {
    const names = await this.redis.smembers(beaconAllKey(this.prefix));
    if (names.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const name of names) pipeline.hgetall(beaconHashKey(this.prefix, name));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: BeaconInstance[] = [];
    for (const [err, hash] of results) {
      if (err) continue;
      const data = hash as Record<string, string>;
      if (!data || Object.keys(data).length === 0) continue;
      out.push(hashToInstance(data));
    }
    out.sort((a, b) => a.beaconName.localeCompare(b.beaconName));
    return out;
  }

  async removeInstance(beaconName: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.del(beaconHashKey(this.prefix, beaconName));
    pipeline.srem(beaconAllKey(this.prefix), beaconName);
    pipeline.del(beaconEventsKey(this.prefix, beaconName));
    await pipeline.exec();
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    const k = beaconEventsKey(this.prefix, event.beaconName);
    const payload = JSON.stringify({
      id: event.id,
      beaconName: event.beaconName,
      incarnation: event.incarnation,
      type: event.type,
      message: event.message ?? null,
      at: event.at.toISOString(),
    });
    // LPUSH → newest first; LTRIM caps retention.
    const pipeline = this.redis.multi();
    pipeline.lpush(k, payload);
    pipeline.ltrim(k, 0, this.maxEvents - 1);
    await pipeline.exec();
  }

  async listEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    const raw = await this.redis.lrange(beaconEventsKey(this.prefix, beaconName), 0, Math.max(0, limit - 1));
    return raw.map((s) => {
      const o = JSON.parse(s) as Record<string, unknown>;
      return {
        id: o.id as string,
        beaconName: o.beaconName as string,
        incarnation: Number(o.incarnation),
        type: o.type as BeaconEvent["type"],
        message: (o.message as string | null) ?? undefined,
        at: new Date(o.at as string),
      };
    });
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === "PONG";
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

function instanceToHash(instance: BeaconInstance): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [field, value] of Object.entries(instance)) {
    if (value === undefined || value === null) continue;
    if (BEACON_DATE_FIELDS.has(field)) {
      hash[field] = (value as Date).toISOString();
    } else {
      hash[field] = String(value);
    }
  }
  return hash;
}

function hashToInstance(hash: Record<string, string>): BeaconInstance {
  const obj: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(hash)) {
    if (BEACON_DATE_FIELDS.has(field)) {
      obj[field] = new Date(value);
    } else if (BEACON_NUMBER_FIELDS.has(field)) {
      obj[field] = Number(value);
    } else {
      obj[field] = value;
    }
  }
  return obj as unknown as BeaconInstance;
}
