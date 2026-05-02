import type {
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
  DynamicBroadcastSpec,
} from "../types.js";

export interface BroadcastQueueAdapter {
  // Broadcast runs
  addBroadcastRun(run: BroadcastRun): Promise<void>;
  getBroadcastRun(id: string): Promise<BroadcastRun | null>;
  updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void>;
  getBroadcastRunsDue(): Promise<BroadcastRun[]>;
  getBroadcastRunsRunning(): Promise<BroadcastRun[]>;
  listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]>;
  hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean>;
  purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number>;

  // Node runs
  addNodeRun(nodeRun: BroadcastNodeRun): Promise<void>;
  getNodeRun(id: string): Promise<BroadcastNodeRun | null>;
  updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void>;
  getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]>;

  // Dynamic broadcast definitions (optional — adapters that don't implement
  // these cannot host runtime-editable broadcasts; static broadcasts still work).
  saveDefinition?(spec: DynamicBroadcastSpec): Promise<DynamicBroadcastSpec>;
  getDefinition?(name: string, version?: number): Promise<DynamicBroadcastSpec | null>;
  listDefinitions?(): Promise<DynamicBroadcastSpec[]>;
  listDefinitionVersions?(name: string): Promise<DynamicBroadcastSpec[]>;
  deleteDefinition?(name: string): Promise<boolean>;

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export { BroadcastMemoryAdapter } from "./memory.js";
