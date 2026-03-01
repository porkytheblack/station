import type { BroadcastRun, BroadcastNodeRun } from "../types.js";
import type { BroadcastSubscriber } from "./index.js";

export class ConsoleBroadcastSubscriber implements BroadcastSubscriber {
  private prefix = "[station-broadcast]";

  onBroadcastDiscovered(event: { broadcastName: string; filePath: string }): void {
    console.log(
      `${this.prefix} Discovered broadcast "${event.broadcastName}" at ${event.filePath}`,
    );
  }

  onBroadcastQueued(event: { broadcastRun: BroadcastRun }): void {
    console.log(
      `${this.prefix} Queued "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id})`,
    );
  }

  onBroadcastStarted(event: { broadcastRun: BroadcastRun }): void {
    console.log(
      `${this.prefix} Started "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id})`,
    );
  }

  onBroadcastCompleted(event: { broadcastRun: BroadcastRun }): void {
    console.log(
      `${this.prefix} Completed "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id})`,
    );
  }

  onBroadcastFailed(event: { broadcastRun: BroadcastRun; error: string }): void {
    console.error(
      `${this.prefix} Failed "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id}): ${event.error}`,
    );
  }

  onBroadcastCancelled(event: { broadcastRun: BroadcastRun }): void {
    console.log(
      `${this.prefix} Cancelled "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id})`,
    );
  }

  onNodeTriggered(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void {
    console.log(
      `${this.prefix}   → Node "${event.nodeRun.nodeName}" triggered for "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id})`,
    );
  }

  onNodeCompleted(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun }): void {
    console.log(
      `${this.prefix}   [ok] Node "${event.nodeRun.nodeName}" completed for "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id})`,
    );
  }

  onNodeFailed(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; error: string }): void {
    console.error(
      `${this.prefix}   [FAIL] Node "${event.nodeRun.nodeName}" failed for "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id}): ${event.error}`,
    );
  }

  onNodeSkipped(event: { broadcastRun: BroadcastRun; nodeRun: BroadcastNodeRun; reason: string }): void {
    console.log(
      `${this.prefix}   [skip] Node "${event.nodeRun.nodeName}" skipped for "${event.broadcastRun.broadcastName}" (${event.broadcastRun.id}): ${event.reason}`,
    );
  }
}
