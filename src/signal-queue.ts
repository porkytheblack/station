import type { SignalQueueAdapter } from "./adapters/index.js";
import { getAdapter } from "./config.js";
import { parseInterval } from "./interval.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type QueueEntry } from "./types.js";

export interface SignalQueueOptions {
  adapter?: SignalQueueAdapter;
}

export class SignalQueue {
  private adapter: SignalQueueAdapter;

  constructor(options: SignalQueueOptions = {}) {
    this.adapter = options.adapter ?? getAdapter();
  }

  async trigger(signalName: string, input: unknown): Promise<string> {
    const id = this.adapter.generateId();
    const entry: QueueEntry = {
      id,
      signalName,
      kind: "trigger",
      input: JSON.stringify(input),
      status: "pending",
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      timeout: DEFAULT_TIMEOUT_MS,
      createdAt: new Date(),
    };
    await this.adapter.add(entry);
    return id;
  }

  async schedule(
    signalName: string,
    interval: string,
    input: unknown,
  ): Promise<string> {
    const ms = parseInterval(interval);
    const id = this.adapter.generateId();
    const entry: QueueEntry = {
      id,
      signalName,
      kind: "recurring",
      input: JSON.stringify(input),
      status: "pending",
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      timeout: DEFAULT_TIMEOUT_MS,
      interval,
      nextRunAt: new Date(Date.now() + ms),
      createdAt: new Date(),
    };
    await this.adapter.add(entry);
    return id;
  }

  async cancel(id: string): Promise<void> {
    await this.adapter.remove(id);
  }

  getAdapter(): SignalQueueAdapter {
    return this.adapter;
  }


}
