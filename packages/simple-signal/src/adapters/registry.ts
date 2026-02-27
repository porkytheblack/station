import type { SignalQueueAdapter } from "./index.js";

export type AdapterFactory = (options: Record<string, unknown>) => SignalQueueAdapter;

const registry = new Map<string, AdapterFactory>();

/**
 * Register an adapter factory by name. Adapters call this at module level
 * so they're available for cross-process reconstruction.
 */
export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

/**
 * Create an adapter instance from its registered name and options.
 * Used by bootstrap to reconstruct the adapter in child processes.
 */
export function createAdapter(name: string, options: Record<string, unknown> = {}): SignalQueueAdapter {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown adapter "${name}". Available adapters: ${[...registry.keys()].join(", ") || "(none)"}. ` +
      `Make sure the adapter package is imported before the runner starts.`,
    );
  }
  return factory(options);
}

/**
 * Check if an adapter is registered by name.
 */
export function hasAdapter(name: string): boolean {
  return registry.has(name);
}
