import { beacon, z } from "station-beacon";

/**
 * ON-DEMAND mode — one beacon definition, many running instances.
 *
 * Nothing is started on discovery. Instead each instance is created at runtime
 * with its own config, so the same worker can be run once per tenant, queue, or
 * stream:
 *
 *   curl -X POST localhost:4400/api/beacons/queue-worker/instances \
 *        -H 'content-type: application/json' \
 *        -d '{"id":"worker-acme","label":"acme","config":{"queue":"acme","batchSize":25}}'
 *
 * Stop one, or remove it entirely, the same way:
 *
 *   curl -X POST   localhost:4400/api/beacons/queue-worker/instances/worker-acme/stop
 *   curl -X DELETE localhost:4400/api/beacons/queue-worker/instances/worker-acme
 *
 * `.maxInstances()` bounds how many can exist at once — the guardrail on an
 * endpoint that spawns processes.
 */
export const queueWorker = beacon("queue-worker")
  .config(
    z.object({
      queue: z.string(),
      batchSize: z.number().default(10),
    }),
  )
  .onDemand()
  .maxInstances(8)
  .restart("on-failure")
  .backoff("1s", { max: "15s" })
  .run(async (ctx) => {
    ctx.log(`worker ${ctx.instanceId} draining "${ctx.config.queue}" in batches of ${ctx.config.batchSize}`);
    ctx.ready();

    while (!ctx.signal.aborted) {
      // Stand-in for real work — pulling a batch off ctx.config.queue.
      await new Promise((r) => setTimeout(r, 2_000));
      if (ctx.signal.aborted) break;
      ctx.log(`[${ctx.config.queue}] processed a batch of ${ctx.config.batchSize}`);
    }
  });
