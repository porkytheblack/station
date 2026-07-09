import { beacon, z } from "../../src/index.js";

// Requires a config field the default empty config {} does not satisfy, so
// validation fails at startup — a fatal, non-restartable error. Uses
// restart("always") to prove even that policy must not restart a fatal error.
export const badConfigBeacon = beacon("bad-config-b")
  .config(z.object({ mode: z.enum(["a", "b"]) }))
  .restart("always")
  .backoff(30, { factor: 1, max: 30 })
  .run(async (ctx) => {
    ctx.ready();
    await ctx.untilStopped();
  });
