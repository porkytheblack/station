import { beacon } from "../../src/index.js";

// Starts (the handler runs, so status becomes "running") but never calls
// ctx.ready() and never returns — the "started but never came up" case. With a
// short startup timeout the supervisor should kill and restart it.
export const startupTimeoutBeacon = beacon("startup-b")
  .startupTimeout(200)
  .stopTimeout(300)
  .restart("on-failure")
  .backoff(40, { factor: 1, max: 40 })
  .run(async (ctx) => {
    // Deliberately never calls ctx.ready().
    await ctx.untilStopped();
  });

// Same never-becomes-ready behaviour, but a `never` restart policy so a startup
// timeout is terminal (the supervisor parks it in `errored`).
export const startupTimeoutNeverBeacon = beacon("startup-never-b")
  .startupTimeout(200)
  .stopTimeout(300)
  .restart("never")
  .run(async (ctx) => {
    await ctx.untilStopped();
  });
