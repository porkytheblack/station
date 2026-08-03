import { signal, z } from "station-signal";

/**
 * Trivial signal for the config-subscribers test. It only needs to run to
 * completion so the parent process emits a full lifecycle.
 */
export const ping = signal("ping")
  .input(z.object({ label: z.string() }))
  .output(z.object({ echoed: z.string() }))
  .run(async (input) => ({ echoed: input.label }));
