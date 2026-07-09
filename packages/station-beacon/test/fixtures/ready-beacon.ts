import { beacon } from "../../src/index.js";

// A server-style beacon: becomes ready, then stays alive until asked to stop.
export const readyBeacon = beacon("ready-b").run(async (ctx) => {
  ctx.ready();
  await ctx.untilStopped();
});
