import type { BeaconEvent, BeaconInstance, BeaconInstancePatch } from "../types.js";

/**
 * Persistence for beacon supervision state. Unlike the signal queue adapter,
 * this is only ever touched by the supervisor process (the authority over which
 * beacons run), so it needs no cross-process reconstruction. Storing state here
 * lets a dashboard observe beacons and lets a restarted supervisor recover the
 * last desired state.
 */
export interface BeaconStateAdapter {
  /** Insert or replace the full instance record for a beacon. */
  upsertInstance(instance: BeaconInstance): Promise<void>;
  /** Fetch a beacon's instance record, or null if it has none yet. */
  getInstance(beaconName: string): Promise<BeaconInstance | null>;
  /** Patch fields on an existing instance record. */
  updateInstance(beaconName: string, patch: BeaconInstancePatch): Promise<void>;
  /** All known instance records. */
  listInstances(): Promise<BeaconInstance[]>;
  /** Remove an instance record entirely. */
  removeInstance(beaconName: string): Promise<void>;

  /** Append a lifecycle event (optional — omit to skip history). */
  addEvent?(event: BeaconEvent): Promise<void>;
  /** Recent lifecycle events for a beacon, newest first (optional). */
  listEvents?(beaconName: string, limit?: number): Promise<BeaconEvent[]>;

  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export { BeaconMemoryAdapter } from "./memory.js";
