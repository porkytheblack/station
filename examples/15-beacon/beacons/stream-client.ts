import { beacon } from "station-beacon";

/**
 * CLIENT mode — maintains a connection to some external source.
 *
 * This one simulates a flaky upstream that drops the connection after a few
 * seconds. Throwing surfaces the drop to the supervisor, which reconnects with
 * exponential backoff (`restart("on-failure")`). It also emits a heartbeat each
 * second; if it ever stopped heart-beating, the supervisor would restart it.
 */
export const streamClient = beacon("stream-client")
  .restart("on-failure")
  .backoff("500ms", { factor: 2, max: "8s" })
  .heartbeat("2s")
  .run(async (ctx) => {
    ctx.log(`connecting (incarnation ${ctx.incarnation})…`);
    ctx.ready();

    const dropsAfterMs = 4_000 + (ctx.incarnation % 3) * 1_000;
    const startedAt = Date.now();

    while (!ctx.signal.aborted) {
      ctx.heartbeat();
      await new Promise((r) => setTimeout(r, 1_000));
      if (Date.now() - startedAt > dropsAfterMs) {
        throw new Error("connection dropped");
      }
    }
  });
