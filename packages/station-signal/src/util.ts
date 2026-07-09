import type { AnySignal } from "./signal.js";

/** Discriminator symbol to identify Signal objects. */
export const SIGNAL_BRAND = Symbol.for("station-signal");

/** Type guard to check if a value is a Signal. */
export function isSignal(value: unknown): value is AnySignal {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[SIGNAL_BRAND] === true;
}

/**
 * Environment variable keys that must never be injected into a spawned child
 * from a managed env store: they change how the process *executes* (loader
 * injection, module resolution, PATH lookup) rather than what handler code
 * reads, so injecting them would turn a storage write into code execution.
 * Kept in sync with `station-env`'s create/update validation; re-checked at the
 * child trust boundary as defense-in-depth for values that entered storage by
 * another route (hand-edited file, direct DB row, custom adapter).
 */
const RESERVED_ENV_KEYS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);
const RESERVED_ENV_PREFIXES = ["STATION_SIGNAL_", "STATION_BEACON_", "__STATION"];

/** Whether an env key is reserved and must not be applied from a managed store. */
export function isReservedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (RESERVED_ENV_KEYS.has(upper)) return true;
  return RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p));
}
