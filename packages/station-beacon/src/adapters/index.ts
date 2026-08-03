import type { BeaconEvent, BeaconInstance, BeaconInstancePatch } from "../types.js";

/** Narrowing filter for {@link BeaconStateAdapter.listInstances}. */
export interface BeaconInstanceFilter {
  /** Only instances of this beacon definition. */
  beaconName?: string;
}

/**
 * Persistence for beacon supervision state. Unlike the signal queue adapter,
 * this is only ever touched by the supervisor process (the authority over which
 * beacons run), so it needs no cross-process reconstruction. Storing state here
 * lets a dashboard observe beacons and lets a restarted supervisor recover both
 * the last desired state and any instances created at runtime.
 *
 * Records are keyed by **instance id**, not beacon name — one definition can
 * have many instances. The definition-owned instance uses the beacon name as
 * its id.
 */
export interface BeaconStateAdapter {
  /** Insert or replace the full record for an instance. */
  upsertInstance(instance: BeaconInstance): Promise<void>;
  /** Fetch an instance record by id, or null if there is none. */
  getInstance(instanceId: string): Promise<BeaconInstance | null>;
  /** Patch fields on an existing instance record. */
  updateInstance(instanceId: string, patch: BeaconInstancePatch): Promise<void>;
  /** All known instance records, optionally narrowed to one beacon. */
  listInstances(filter?: BeaconInstanceFilter): Promise<BeaconInstance[]>;
  /** Remove an instance record (and its events) entirely. */
  removeInstance(instanceId: string): Promise<void>;

  /** Append a lifecycle event (optional — omit to skip history). */
  addEvent?(event: BeaconEvent): Promise<void>;
  /** Recent lifecycle events for one instance, newest first (optional). */
  listEvents?(instanceId: string, limit?: number): Promise<BeaconEvent[]>;
  /** Recent lifecycle events across every instance of a beacon, newest first (optional). */
  listBeaconEvents?(beaconName: string, limit?: number): Promise<BeaconEvent[]>;

  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export { BeaconMemoryAdapter } from "./memory.js";
