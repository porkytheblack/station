import { randomUUID } from "node:crypto";
import type { BeaconStateAdapter } from "./index.js";
import type { BeaconEvent, BeaconInstance, BeaconInstancePatch } from "../types.js";

/**
 * In-process beacon state adapter. Fine for single-process supervisors and
 * tests. State is lost on restart, so the supervisor re-derives desired state
 * from each beacon's `autoStart` flag on the next boot. For durable state
 * across restarts, back this interface with SQLite/Postgres/etc.
 */
export class BeaconMemoryAdapter implements BeaconStateAdapter {
  private instances = new Map<string, BeaconInstance>();
  private events: BeaconEvent[] = [];
  private maxEvents: number;

  constructor(options?: { maxEvents?: number }) {
    this.maxEvents = options?.maxEvents ?? 5_000;
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    this.instances.set(instance.beaconName, { ...instance });
  }

  async getInstance(beaconName: string): Promise<BeaconInstance | null> {
    const found = this.instances.get(beaconName);
    return found ? { ...found } : null;
  }

  async updateInstance(beaconName: string, patch: BeaconInstancePatch): Promise<void> {
    const instance = this.instances.get(beaconName);
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

  async listInstances(): Promise<BeaconInstance[]> {
    return Array.from(this.instances.values()).map((i) => ({ ...i }));
  }

  async removeInstance(beaconName: string): Promise<void> {
    this.instances.delete(beaconName);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    this.events.push({ ...event });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  async listEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
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
    this.instances.clear();
    this.events = [];
  }
}
