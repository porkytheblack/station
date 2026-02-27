const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse a simple interval string like "5m", "30s", "1h", "2d".
 * The "every" prefix is optional for backwards compatibility (e.g. "every 5m" also works).
 * Returns milliseconds.
 */
export function parseInterval(interval: string): number {
  const match = interval.match(/^(?:every\s+)?(\d+)\s*([smhd])$/i);
  if (!match) {
    throw new Error(
      `Invalid interval "${interval}". Expected format: "<number><s|m|h|d>" (e.g. "5m", "30s", "1h")`,
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = UNITS[unit];
  if (!ms || value <= 0) {
    throw new Error(`Invalid interval "${interval}"`);
  }
  return value * ms;
}
