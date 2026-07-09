import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "Beacon — Examples — Station",
};

export default function BeaconExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>Beacon</h2>
      <p>
        Three long-running, supervised processes — a server, a poller, and a
        reconnecting client — kept alive by the <code>BeaconRunner</code>. See
        the <Link href="/docs/beacons">Beacons API</Link> for the full reference.
      </p>

      <h4>beacons/health-server.ts — server mode</h4>
      <Code>{`import { beacon, z } from "station-beacon";
import { createServer } from "node:http";

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
    ctx.ready();
    ctx.onStop(async () => { await new Promise<void>((r) => server.close(() => r())); });
    await ctx.untilStopped();
  });`}</Code>

      <h4>beacons/uptime-poller.ts — poll mode</h4>
      <Code>{`import { beacon } from "station-beacon";

export const uptimePoller = beacon("uptime-poller").poll("3s", async (ctx) => {
  try {
    const res = await fetch("http://localhost:8099/", { signal: ctx.signal });
    const body = (await res.json()) as { hits: number };
    ctx.log(\`health-server up — \${body.hits} total hits\`);
  } catch (err) {
    if (ctx.signal.aborted) return;
    ctx.log(\`health-server DOWN: \${(err as Error).message}\`);
  }
});`}</Code>

      <h4>beacons/stream-client.ts — client mode</h4>
      <Code>{`import { beacon } from "station-beacon";

// Simulates a flaky upstream that drops the connection; throwing lets the
// supervisor reconnect with exponential backoff.
export const streamClient = beacon("stream-client")
  .restart("on-failure")
  .backoff("500ms", { factor: 2, max: "8s" })
  .heartbeat("2s")
  .run(async (ctx) => {
    ctx.log(\`connecting (incarnation \${ctx.incarnation})…\`);
    ctx.ready();
    const dropsAfterMs = 4_000 + (ctx.incarnation % 3) * 1_000;
    const startedAt = Date.now();
    while (!ctx.signal.aborted) {
      ctx.heartbeat();
      await new Promise((r) => setTimeout(r, 1_000));
      if (Date.now() - startedAt > dropsAfterMs) throw new Error("connection dropped");
    }
  });`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { BeaconRunner, ConsoleBeaconSubscriber } from "station-beacon";

const runner = BeaconRunner.create(path.join(import.meta.dirname, "beacons"), {
  subscribers: [new ConsoleBeaconSubscriber()],
  pollIntervalMs: 500,
});

await runner.start(); // Ctrl-C runs each beacon's onStop cleanup, then exits`}</Code>

      <div className="info-box">
        <p>
          Watch the client drop and get restarted with a growing backoff
          (500ms → 1s → 2s…). The server stays up under{" "}
          <code>restart(&quot;always&quot;)</code>; the poller reports live hit
          counts. Press <code>Ctrl-C</code> for a graceful shutdown.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter simple-example-15-beacon start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
