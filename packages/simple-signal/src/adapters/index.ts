import type { QueueEntry } from "../types.js";

export interface SignalQueueAdapter {
  add(entry: QueueEntry): Promise<void>;
  remove(id: string): Promise<void>;
  getDue(): Promise<QueueEntry[]>;
  getRunning(): Promise<QueueEntry[]>;
  update(id: string, patch: Partial<QueueEntry>): Promise<void>;
  ping(): Promise<boolean>;
  generateId(): string;
}

export { MemoryAdapter } from "./memory.js";
