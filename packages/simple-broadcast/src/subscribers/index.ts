import type { BroadcastRun, BroadcastNodeRun } from "../types.js";

export interface BroadcastSubscriber {
  /** Broadcast definition discovered during auto-discovery. */
  onBroadcastDiscovered?(event: { broadcastName: string; filePath: string }): void;

  /** Broadcast run created and queued. */
  onBroadcastQueued?(event: { broadcastRun: BroadcastRun }): void;

  /** Broadcast run started (first nodes being triggered). */
  onBroadcastStarted?(event: { broadcastRun: BroadcastRun }): void;

  /** All nodes completed successfully. */
  onBroadcastCompleted?(event: { broadcastRun: BroadcastRun }): void;

  /** Broadcast failed (at least one required node failed). */
  onBroadcastFailed?(event: { broadcastRun: BroadcastRun; error: string }): void;

  /** Broadcast cancelled. */
  onBroadcastCancelled?(event: { broadcastRun: BroadcastRun }): void;

  /** A node's signal was triggered. */
  onNodeTriggered?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void;

  /** A node's signal completed. */
  onNodeCompleted?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void;

  /** A node's signal failed. */
  onNodeFailed?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; error: string }): void;

  /** A node was skipped (guard returned false or upstream failed). */
  onNodeSkipped?(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; reason: string }): void;
}

export { ConsoleBroadcastSubscriber } from "./console.js";
