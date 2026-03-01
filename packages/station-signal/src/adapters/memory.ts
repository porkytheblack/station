import { randomUUID } from "node:crypto";
import type { SignalQueueAdapter } from "./index.js";
import type { Run, RunPatch, RunStatus, Step, StepPatch } from "../types.js";
import { registerAdapter } from "./registry.js";

/**
 * In-process memory adapter. Useful for single-process scripts and testing.
 * Does NOT implement SerializableAdapter — child processes get their own
 * independent MemoryAdapter. Use SqliteAdapter for cross-process persistence.
 */
export class MemoryAdapter implements SignalQueueAdapter {
  private runs = new Map<string, Run>();
  private steps = new Map<string, Step>();
  private maxRuns: number;

  constructor(options?: { maxRuns?: number }) {
    this.maxRuns = options?.maxRuns ?? 10_000;
  }

  async addRun(run: Run): Promise<void> {
    this.runs.set(run.id, run);
    if (this.runs.size > this.maxRuns) {
      this.evictCompleted();
    }
  }

  private evictCompleted(): void {
    const terminal: string[] = [];
    for (const [id, run] of this.runs) {
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        terminal.push(id);
      }
    }
    // Sort oldest first by completedAt
    terminal.sort((a, b) => {
      const ra = this.runs.get(a)!;
      const rb = this.runs.get(b)!;
      return (ra.completedAt?.getTime() ?? 0) - (rb.completedAt?.getTime() ?? 0);
    });
    // Evict oldest 10%
    const evictCount = Math.max(1, Math.floor(terminal.length * 0.1));
    for (let i = 0; i < evictCount && i < terminal.length; i++) {
      const id = terminal[i];
      this.runs.delete(id);
      for (const [stepId, step] of this.steps) {
        if (step.runId === id) this.steps.delete(stepId);
      }
    }
  }

  async removeRun(id: string): Promise<void> {
    this.runs.delete(id);
    await this.removeSteps(id);
  }

  async getRunsDue(): Promise<Run[]> {
    const now = new Date();
    return Array.from(this.runs.values())
      .filter((run) => {
        if (run.status !== "pending") return false;
        if (!run.nextRunAt) return true;
        return run.nextRunAt <= now;
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getRunsRunning(): Promise<Run[]> {
    return Array.from(this.runs.values()).filter(
      (run) => run.status === "running",
    );
  }

  async getRun(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null;
  }

  async updateRun(id: string, patch: RunPatch): Promise<void> {
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

  async listRuns(signalName: string): Promise<Run[]> {
    return Array.from(this.runs.values()).filter(
      (run) => run.signalName === signalName,
    );
  }

  async hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean> {
    const statusSet = new Set(statuses);
    for (const run of this.runs.values()) {
      if (run.signalName === signalName && statusSet.has(run.status)) return true;
    }
    return false;
  }

  async purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number> {
    const statusSet = new Set(statuses);
    let purged = 0;
    for (const [id, run] of this.runs) {
      if (statusSet.has(run.status) && run.completedAt && run.completedAt < olderThan) {
        this.runs.delete(id);
        await this.removeSteps(id);
        purged++;
      }
    }
    return purged;
  }

  async addStep(step: Step): Promise<void> {
    this.steps.set(step.id, step);
  }

  async updateStep(id: string, patch: StepPatch): Promise<void> {
    const step = this.steps.get(id);
    if (step) {
      const rec = step as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete rec[key];
        } else {
          rec[key] = value;
        }
      }
    }
  }

  async getSteps(runId: string): Promise<Step[]> {
    return Array.from(this.steps.values()).filter(
      (step) => step.runId === runId,
    );
  }

  async removeSteps(runId: string): Promise<void> {
    for (const [id, step] of this.steps) {
      if (step.runId === runId) {
        this.steps.delete(id);
      }
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  generateId(): string {
    return randomUUID();
  }

  async close(): Promise<void> {
    this.runs.clear();
    this.steps.clear();
  }
}

// Register in the adapter factory for cross-process reconstruction
registerAdapter("memory", () => new MemoryAdapter());
