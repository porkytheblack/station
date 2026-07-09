import { beacon, z } from "station-beacon";
import { createServer } from "node:http";

/**
 * SERVER mode — a long-running HTTP server.
 *
 * The handler starts the server, marks the beacon ready, registers a cleanup
 * hook, then parks on `untilStopped()`. `restart("always")` means the
 * supervisor brings it straight back up if it ever exits.
 */
export const healthServer = beacon("health-server")
  .config(z.object({ port: z.number().default(8099) }))
  .withConfig({ port: 8099 })
  .restart("always")
  .backoff("1s", { max: "10s" })
  .run(async (ctx) => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, hits }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ctx.config.port, resolve);
    });

    ctx.log(`listening on http://localhost:${ctx.config.port}`);
    ctx.ready();

    ctx.onStop(async () => {
      ctx.log("closing server…");
      await new Promise<void>((r) => server.close(() => r()));
    });

    await ctx.untilStopped();
  });
