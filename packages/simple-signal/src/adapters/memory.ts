import type { SignalQueueAdapter } from "./index.js";
import type { QueueEntry } from "../types.js";

export class MemoryAdapter implements SignalQueueAdapter {
  private entries = new Map<string, QueueEntry>();

  async add(entry: QueueEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async getDue(): Promise<QueueEntry[]> {
    const now = new Date();
    return Array.from(this.entries.values()).filter((entry) => {
      if (entry.status !== "pending") return false;
      if (!entry.nextRunAt) return true;
      return entry.nextRunAt <= now;
    });
  }

  async getRunning(): Promise<QueueEntry[]> {
    return Array.from(this.entries.values()).filter(
      (entry) => entry.status === "running",
    );
  }

  async update(id: string, patch: Partial<QueueEntry>): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      Object.assign(entry, patch);
    }
  }

  async ping(): Promise<boolean> {
    return true;
  }

  generateId(): string {
    return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
