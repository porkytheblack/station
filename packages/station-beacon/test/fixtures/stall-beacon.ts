import { beacon } from "../../src/index.js";

// Declares a heartbeat but never sends one — the supervisor should detect the
// stall and restart it.
export const stallBeacon = beacon("stall-b")
  .heartbeat(80, { timeout: 220 })
  .restart("on-failure")
  .backoff(40, { factor: 1, max: 40 })
  .run(async (ctx) => {
    ctx.ready();
    await ctx.untilStopped();
  });
