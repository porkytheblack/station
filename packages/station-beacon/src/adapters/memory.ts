import { randomUUID } from "node:crypto";
import type { BeaconInstanceFilter, BeaconStateAdapter } from "./index.js";
import type { BeaconEvent, BeaconInstance, BeaconInstancePatch } from "../types.js";

/**
 * In-process beacon state adapter. Fine for single-process supervisors and
 * tests. State is lost on restart, so the supervisor re-derives desired state
 * from each beacon's start mode on the next boot and runtime-created instances
 * do not survive. For durable state across restarts, back this interface with
 * SQLite/Postgres/etc.
 */
export class BeaconMemoryAdapter implements BeaconStateAdapter {
  private instances = new Map<string, BeaconInstance>();
  private events: BeaconEvent[] = [];
  private maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 5_000;
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    this.instances.set(instance.id, { ...instance });
  }

  async getInstance(instanceId: string): Promise<BeaconInstance | null> {
    const found = this.instances.get(instanceId);
    return found ? { ...found } : null;
  }

  async updateInstance(instanceId: string, patch: BeaconInstancePatch): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    const rec = instance as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (value === undefined) {
        delete rec[key];
      } else {
        rec[key] = value;
      }
    }
    instance.updatedAt = patch.updatedAt ?? new Date();
  }

  async listInstances(filter?: BeaconInstanceFilter): Promise<BeaconInstance[]> {
    const all = Array.from(this.instances.values());
    const scoped = filter?.beaconName
      ? all.filter((i) => i.beaconName === filter.beaconName)
      : all;
    return scoped.map((i) => ({ ...i })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async removeInstance(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
    this.events = this.events.filter((e) => e.instanceId !== instanceId);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    this.events.push({ ...event });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  async listEvents(instanceId: string, limit = 100): Promise<BeaconEvent[]> {
    const filtered = this.events.filter((e) => e.instanceId === instanceId);
    return filtered.slice(-limit).reverse();
  }

  async listBeaconEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    const filtered = this.events.filter((e) => e.beaconName === beaconName);
    return filtered.slice(-limit).reverse();
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // No resources to release; the adapter may be shared in process.
  }
}
