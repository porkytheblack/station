import { beacon, z } from "station-beacon";

/**
 * Beacon fixtures for the v1 beacon route tests. They live in their own file
 * because the supervisor spawns a beacon's *file* as a child process — pointing
 * a beacon at the test file itself would re-run the suite in every child.
 */

/** Runs only instances created through the API — the case these routes exist for. */
export const workerBeacon = beacon("worker")
  .config(z.object({ queue: z.string() }))
  .onDemand()
  .maxInstances(2)
  .run(async (ctx) => {
    ctx.ready();
    await ctx.untilStopped();
  });

/** Has one definition-owned instance, seeded but left stopped. */
export const serverBeacon = beacon("server")
  .config(z.object({ port: z.number().default(8080) }))
  .manualStart()
  .run(async (ctx) => {
    ctx.ready();
    await ctx.untilStopped();
  });
