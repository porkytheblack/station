import { MemoryAdapter } from "./adapters/memory.js";
import type { SignalQueueAdapter } from "./adapters/index.js";

let _adapter: SignalQueueAdapter = new MemoryAdapter();
let _configured = false;
let _warnedUnconfigured = false;

export function configure(options: { adapter: SignalQueueAdapter }): void {
  if (_configured) {
    console.warn(
      "[station-signal] configure() called multiple times. The previous adapter will be replaced. " +
      "If you have multiple runners, each should use its own adapter instance.",
    );
  }
  _adapter = options.adapter;
  _configured = true;
}

export function getAdapter(): SignalQueueAdapter {
  if (!_configured && !_warnedUnconfigured) {
    _warnedUnconfigured = true;
    console.warn(
      "[station-signal] No adapter configured — using default MemoryAdapter. " +
      "Call configure({ adapter }) or pass an adapter to SignalRunner for persistent storage.",
    );
  }
  return _adapter;
}

/** Returns true if configure() has been called. */
export function isConfigured(): boolean {
  return _configured;
}
