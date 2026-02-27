import { randomUUID } from "node:crypto";
import type { BroadcastQueueAdapter } from "./index.js";
import type {
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
} from "../types.js";

export class BroadcastMemoryAdapter implements BroadcastQueueAdapter {
  private runs = new Map<string, BroadcastRun>();
  private nodeRuns = new Map<string, BroadcastNodeRun>();

  async addBroadcastRun(run: BroadcastRun): Promise<void> {
    this.runs.set(run.id, run);
  }

  async getBroadcastRun(id: string): Promise<BroadcastRun | null> {
    return this.runs.get(id) ?? null;
  }

  async updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void> {
    const run = this.runs.get(id);
    if (run) {
      const rec = run as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete rec[key];
        } else {
          rec[key] = value;
        }
      }
    }
  }

  async getBroadcastRunsDue(): Promise<BroadcastRun[]> {
    const now = new Date();
    return Array.from(this.runs.values())
      .filter((run) => {
        if (run.status !== "pending") return false;
        if (!run.nextRunAt) return true;
        return run.nextRunAt <= now;
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getBroadcastRunsRunning(): Promise<BroadcastRun[]> {
    return Array.from(this.runs.values()).filter(
      (run) => run.status === "running",
    );
  }

  async listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]> {
    return Array.from(this.runs.values()).filter(
      (run) => run.broadcastName === broadcastName,
    );
  }

  async hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean> {
    const statusSet = new Set(statuses);
    for (const run of this.runs.values()) {
      if (run.broadcastName === broadcastName && statusSet.has(run.status)) return true;
    }
    return false;
  }

  async purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number> {
    const statusSet = new Set(statuses);
    // M4: Collect IDs first, then delete — avoids mutating Map during iteration
    const toPurge: string[] = [];
    for (const [id, run] of this.runs) {
      if (statusSet.has(run.status) && run.completedAt && run.completedAt < olderThan) {
        toPurge.push(id);
      }
    }
    for (const id of toPurge) {
      this.runs.delete(id);
      // Collect node run IDs to delete
      const nodeRunIds: string[] = [];
      for (const [nrId, nr] of this.nodeRuns) {
        if (nr.broadcastRunId === id) nodeRunIds.push(nrId);
      }
      for (const nrId of nodeRunIds) {
        this.nodeRuns.delete(nrId);
      }
    }
    return toPurge.length;
  }

  async addNodeRun(nodeRun: BroadcastNodeRun): Promise<void> {
    this.nodeRuns.set(nodeRun.id, nodeRun);
  }

  async getNodeRun(id: string): Promise<BroadcastNodeRun | null> {
    return this.nodeRuns.get(id) ?? null;
  }

  async updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void> {
    const nodeRun = this.nodeRuns.get(id);
    if (nodeRun) {
      const rec = nodeRun as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete rec[key];
        } else {
          rec[key] = value;
        }
      }
    }
  }

  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]> {
    return Array.from(this.nodeRuns.values()).filter(
      (nr) => nr.broadcastRunId === broadcastRunId,
    );
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.runs.clear();
    this.nodeRuns.clear();
  }
}
