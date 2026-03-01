import type {
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
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

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

export { BroadcastMemoryAdapter } from "./memory.js";
