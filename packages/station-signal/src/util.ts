import type { AnySignal } from "./signal.js";

/** Discriminator symbol to identify Signal objects. */
export const SIGNAL_BRAND = Symbol.for("station-signal");

/** Type guard to check if a value is a Signal. */
export function isSignal(value: unknown): value is AnySignal {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[SIGNAL_BRAND] === true;
}
