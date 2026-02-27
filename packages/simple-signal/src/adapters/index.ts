import type { Run, RunPatch, Step, StepPatch } from "../types.js";

export interface SignalQueueAdapter {
  // Run methods
  addRun(run: Run): Promise<void>;
  removeRun(id: string): Promise<void>;
  getRunsDue(): Promise<Run[]>;
  getRunsRunning(): Promise<Run[]>;
  getRun(id: string): Promise<Run | null>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  listRuns(signalName: string): Promise<Run[]>;

  // Step methods
  addStep(step: Step): Promise<void>;
  updateStep(id: string, patch: StepPatch): Promise<void>;
  getSteps(runId: string): Promise<Step[]>;
  removeSteps(runId: string): Promise<void>;

  // Utility
  generateId(): string;
  ping(): Promise<boolean>;
  close?(): Promise<void>;
}

/**
 * Metadata an adapter carries so child processes can reconstruct it.
 * Adapters that implement SerializableAdapter are fully automatic —
 * no extra runner config needed.
 */
export interface AdapterManifest {
  /** Registry name (e.g. "sqlite"). Matches registerAdapter() name. */
  name: string;
  /** Serializable options to pass to the factory. */
  options: Record<string, unknown>;
  /**
   * Resolved absolute path/URL to the module that registers this adapter.
   * Only needed for external (non-built-in) adapters.
   */
  moduleUrl?: string;
}

/**
 * Adapters that can be reconstructed in child processes implement this.
 * MemoryAdapter intentionally does NOT implement this since it cannot
 * share state across processes.
 */
export interface SerializableAdapter extends SignalQueueAdapter {
  toManifest(): AdapterManifest;
}

export function isSerializableAdapter(
  adapter: SignalQueueAdapter,
): adapter is SerializableAdapter {
  return typeof (adapter as SerializableAdapter).toManifest === "function";
}

export { MemoryAdapter } from "./memory.js";
export { registerAdapter, createAdapter, hasAdapter } from "./registry.js";
