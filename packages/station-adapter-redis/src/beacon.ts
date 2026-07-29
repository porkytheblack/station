import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import type {
  BeaconStateAdapter,
  BeaconInstance,
  BeaconInstanceFilter,
  BeaconInstancePatch,
  BeaconEvent,
} from "station-beacon";
import { key, patchToHashArgs } from "./shared.js";

export interface BeaconRedisAdapterOptions {
  url?: string;
  redis?: Redis;
  prefix?: string;
  /** Max lifecycle events retained per instance. @default 1000 */
  maxEventsPerBeacon?: number;
}

// Keyed by instance id. A beacon's definition-owned instance uses the beacon
// name as its id, so records written before multi-instance support live at
// exactly these keys already and need no data migration — only the `id`,
// `beaconName`, and `origin` fields are defaulted on read.
const beaconHashKey = (prefix: string, instanceId: string) => key(prefix, "beacon", instanceId);
const beaconAllKey = (prefix: string) => key(prefix, "beacons", "all");
const beaconEventsKey = (prefix: string, instanceId: string) =>
  key(prefix, "beacon-events", instanceId);

const BEACON_DATE_FIELDS = new Set([
  "startedAt", "readyAt", "lastHeartbeatAt", "lastExitAt", "nextRestartAt", "createdAt", "updatedAt",
]);
const BEACON_NUMBER_FIELDS = new Set(["incarnation", "restartCount", "pid"]);
const BEACON_PATCH_KEYS = new Set([
  "label", "status", "desiredState", "incarnation", "restartCount", "pid", "config",
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
    const k = beaconHashKey(this.prefix, instance.id);
    // DEL + HSET fully replaces so a field that became undefined doesn't linger.
    const pipeline = this.redis.multi();
    pipeline.del(k);
    pipeline.hset(k, hash);
    pipeline.sadd(beaconAllKey(this.prefix), instance.id);
    await pipeline.exec();
  }

  async getInstance(instanceId: string): Promise<BeaconInstance | null> {
    const hash = await this.redis.hgetall(beaconHashKey(this.prefix, instanceId));
    if (!hash || Object.keys(hash).length === 0) return null;
    return hashToInstance(hash, instanceId);
  }

  async updateInstance(instanceId: string, patch: BeaconInstancePatch): Promise<void> {
    const exists = await this.redis.exists(beaconHashKey(this.prefix, instanceId));
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
    const k = beaconHashKey(this.prefix, instanceId);
    const pipeline = this.redis.multi();
    if (Object.keys(setArgs).length > 0) pipeline.hset(k, setArgs);
    if (delFields.length > 0) pipeline.hdel(k, ...delFields);
    await pipeline.exec();
  }

  async listInstances(filter?: BeaconInstanceFilter): Promise<BeaconInstance[]> {
    const ids = await this.redis.smembers(beaconAllKey(this.prefix));
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(beaconHashKey(this.prefix, id));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: BeaconInstance[] = [];
    results.forEach(([err, hash], i) => {
      if (err) return;
      const data = hash as Record<string, string>;
      if (!data || Object.keys(data).length === 0) return;
      const inst = hashToInstance(data, ids[i]);
      // Instance counts are small, so filtering in memory beats maintaining a
      // second per-beacon index that would have to be migrated and kept in sync.
      if (filter?.beaconName && inst.beaconName !== filter.beaconName) return;
      out.push(inst);
    });
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  async removeInstance(instanceId: string): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.del(beaconHashKey(this.prefix, instanceId));
    pipeline.srem(beaconAllKey(this.prefix), instanceId);
    pipeline.del(beaconEventsKey(this.prefix, instanceId));
    await pipeline.exec();
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    const k = beaconEventsKey(this.prefix, event.instanceId);
    const payload = JSON.stringify({
      id: event.id,
      instanceId: event.instanceId,
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

  async listEvents(instanceId: string, limit = 100): Promise<BeaconEvent[]> {
    const raw = await this.redis.lrange(
      beaconEventsKey(this.prefix, instanceId),
      0,
      Math.max(0, limit - 1),
    );
    return raw.map((s) => parseEvent(s, instanceId));
  }

  /**
   * Events live in a per-instance list, so a definition-wide timeline is a merge
   * across that beacon's instances rather than a single range read.
   */
  async listBeaconEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    const instances = await this.listInstances({ beaconName });
    if (instances.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const inst of instances) {
      pipeline.lrange(beaconEventsKey(this.prefix, inst.id), 0, Math.max(0, limit - 1));
    }
    const results = await pipeline.exec();
    if (!results) return [];
    const out: BeaconEvent[] = [];
    results.forEach(([err, raw], i) => {
      if (err || !Array.isArray(raw)) return;
      for (const s of raw as string[]) out.push(parseEvent(s, instances[i].id));
    });
    return out.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
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

function hashToInstance(hash: Record<string, string>, instanceId: string): BeaconInstance {
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
  // Hashes written before multi-instance support carry neither id nor origin;
  // they are a beacon's definition-owned instance, whose id is the beacon name.
  obj.id ??= instanceId;
  obj.beaconName ??= instanceId;
  obj.origin ??= "definition";
  return obj as unknown as BeaconInstance;
}

function parseEvent(raw: string, instanceId: string): BeaconEvent {
  const o = JSON.parse(raw) as Record<string, unknown>;
  return {
    id: o.id as string,
    instanceId: (o.instanceId as string | undefined) ?? instanceId,
    beaconName: o.beaconName as string,
    incarnation: Number(o.incarnation),
    type: o.type as BeaconEvent["type"],
    message: (o.message as string | null) ?? undefined,
    at: new Date(o.at as string),
  };
}
