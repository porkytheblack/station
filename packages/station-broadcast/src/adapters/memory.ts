import { randomUUID } from "node:crypto";
import type { BroadcastQueueAdapter } from "./index.js";
import type {
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
  DynamicBroadcastSpec,
} from "../types.js";

export class BroadcastMemoryAdapter implements BroadcastQueueAdapter {
  private runs = new Map<string, BroadcastRun>();
  private nodeRuns = new Map<string, BroadcastNodeRun>();
  /** name -> version -> spec (full version history retained). */
  private definitions = new Map<string, Map<number, DynamicBroadcastSpec>>();

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

  // ─── Dynamic broadcast definitions ───────────────────────────────

  async saveDefinition(spec: DynamicBroadcastSpec): Promise<DynamicBroadcastSpec> {
    let versions = this.definitions.get(spec.name);
    if (!versions) {
      versions = new Map();
      this.definitions.set(spec.name, versions);
    }
    const latestVersion = Math.max(0, ...Array.from(versions.keys()));
    const next: DynamicBroadcastSpec = {
      ...spec,
      version: latestVersion + 1,
      createdAt: spec.createdAt ?? new Date(),
      updatedAt: new Date(),
      deletedAt: undefined,
    };
    versions.set(next.version, next);
    return next;
  }

  async getDefinition(name: string, version?: number): Promise<DynamicBroadcastSpec | null> {
    const versions = this.definitions.get(name);
    if (!versions || versions.size === 0) return null;
    if (version !== undefined) return versions.get(version) ?? null;
    const latest = Math.max(...versions.keys());
    return versions.get(latest) ?? null;
  }

  async listDefinitions(): Promise<DynamicBroadcastSpec[]> {
    const out: DynamicBroadcastSpec[] = [];
    for (const versions of this.definitions.values()) {
      if (versions.size === 0) continue;
      const latest = Math.max(...versions.keys());
      const spec = versions.get(latest)!;
      if (spec.deletedAt) continue;
      out.push(spec);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listDefinitionVersions(name: string): Promise<DynamicBroadcastSpec[]> {
    const versions = this.definitions.get(name);
    if (!versions) return [];
    return Array.from(versions.values()).sort((a, b) => b.version - a.version);
  }

  async deleteDefinition(name: string): Promise<boolean> {
    const versions = this.definitions.get(name);
    if (!versions || versions.size === 0) return false;
    const latest = Math.max(...versions.keys());
    const spec = versions.get(latest)!;
    if (spec.deletedAt) return false;
    versions.set(latest, { ...spec, deletedAt: new Date() });
    return true;
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
    this.definitions.clear();
  }
}
