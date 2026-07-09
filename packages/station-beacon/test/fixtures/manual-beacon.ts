import { beacon } from "../../src/index.js";

// Does not auto-start — stays stopped until startBeacon() is called.
export const manualBeacon = beacon("manual-b")
  .manualStart()
  .run(async (ctx) => {
    ctx.ready();
    await ctx.untilStopped();
  });
