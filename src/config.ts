import { MemoryAdapter } from "./adapters/memory.js";
import type { SignalQueueAdapter } from "./adapters/index.js";

let _adapter: SignalQueueAdapter = new MemoryAdapter();

export function configure(options: { adapter: SignalQueueAdapter }): void {
  _adapter = options.adapter;
}

export function getAdapter(): SignalQueueAdapter {
  return _adapter;
}
