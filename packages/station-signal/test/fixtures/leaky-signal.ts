import { signal, z } from "../../src/index.js";

/**
 * Fixture: completes successfully but leaves a live timer behind, so its event
 * loop never drains on its own. Models the production shape — a pool client
 * acquired and never released, a `fetch` with no `AbortSignal` — that left
 * zero-CPU processes resident until the container could no longer fork.
 */
export const leakySignal = signal("leaky-signal")
  .input(z.object({}))
  .output(z.object({ ok: z.boolean() }))
  .run(async () => {
    // Deliberately never cleared, and deliberately not unref'd.
    setInterval(() => {}, 1_000);
    return { ok: true };
  });

/**
 * Fixture: leaks a handle *and* refuses every polite request to leave — it
 * disables its own drain and swallows SIGTERM. Only the runner's SIGKILL
 * escalation can end it.
 */
export const stubbornSignal = signal("stubborn-signal")
  .input(z.object({}))
  .output(z.object({ ok: z.boolean() }))
  .run(async () => {
    process.env.STATION_SIGNAL_DRAIN_MS = "0";
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    return { ok: true };
  });
