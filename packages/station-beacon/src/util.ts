import type { AnyBeacon } from "./beacon.js";

/** Discriminator symbol to identify Beacon objects during auto-discovery. */
export const BEACON_BRAND = Symbol.for("station-beacon");

/** Type guard to check if a value is a Beacon definition. */
export function isBeacon(value: unknown): value is AnyBeacon {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<symbol, unknown>)[BEACON_BRAND] === true;
}
