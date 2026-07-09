import { beacon } from "station-beacon";

/**
 * POLLER mode — runs a function on an interval.
 *
 * The framework calls this every 3 seconds and marks the beacon ready on the
 * first tick. Passing `ctx.signal` to `fetch` means an in-flight request is
 * aborted the moment the beacon is asked to stop.
 */
export const uptimePoller = beacon("uptime-poller").poll("3s", async (ctx) => {
  try {
    const res = await fetch("http://localhost:8099/", { signal: ctx.signal });
    const body = (await res.json()) as { hits: number };
    ctx.log(`health-server up — ${body.hits} total hits`);
  } catch (err) {
    if (ctx.signal.aborted) return; // stopping — ignore the aborted request
    ctx.log(`health-server DOWN: ${(err as Error).message}`);
  }
});
