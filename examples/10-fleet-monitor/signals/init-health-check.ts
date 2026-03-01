import { signal, z } from "station-signal";

// Entry point for the full-health-check broadcast.
// Accepts an optional label, passes through to downstream checks.
export const initHealthCheck = signal("init-health-check")
  .input(z.object({ label: z.string().optional() }))
  .output(z.object({ label: z.string(), startedAt: z.string() }))
  .run(async (input) => {
    const label = input.label ?? `health-${Date.now().toString(36)}`;
    console.log(`[health-check] Starting full fleet check: ${label}`);
    return { label, startedAt: new Date().toISOString() };
  });
