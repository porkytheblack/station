import { BroadcastMemoryAdapter } from "./adapters/memory.js";
import type { BroadcastQueueAdapter } from "./adapters/index.js";

let _adapter: BroadcastQueueAdapter = new BroadcastMemoryAdapter();
let _configured = false;
let _warnedUnconfigured = false;

export function configureBroadcast(options: { adapter: BroadcastQueueAdapter }): void {
  if (_configured) {
    console.warn(
      "[station-broadcast] configureBroadcast() called multiple times. The previous adapter will be replaced.",
    );
  }
  _adapter = options.adapter;
  _configured = true;
}

export function getBroadcastAdapter(): BroadcastQueueAdapter {
  if (!_configured && !_warnedUnconfigured) {
    _warnedUnconfigured = true;
    console.warn(
      "[station-broadcast] No adapter configured — using default BroadcastMemoryAdapter. " +
      "Call configureBroadcast({ adapter }) for persistent storage.",
    );
  }
  return _adapter;
}

export function isBroadcastConfigured(): boolean {
  return _configured;
}
