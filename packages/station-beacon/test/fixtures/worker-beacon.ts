import { beacon, z } from "../../src/index.js";

// An on-demand beacon: nothing is seeded on discovery. Instances are created at
// runtime, each with its own config, and each logs which one it is so tests can
// tell the processes apart.
export const workerBeacon = beacon("worker-b")
  .config(z.object({ queue: z.string() }))
  .onDemand()
  .maxInstances(3)
  .run(async (ctx) => {
    ctx.log(`worker ${ctx.instanceId} on queue ${ctx.config.queue}`);
    ctx.ready();
    await ctx.untilStopped();
  });
