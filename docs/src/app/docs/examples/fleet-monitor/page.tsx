import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "Fleet Monitor — Examples — Station",
};

export default function FleetMonitorExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>Fleet Monitor</h2>
      <p>
        Real-time service health monitoring. Six parallel health check signals
        fan out from an init signal and converge into an aggregate report.
        Triggered on a recurring 60-second interval.
      </p>

      <h4>broadcasts/full-health-check.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { initHealthCheck } from "../signals/init-health-check.js";
import { checkApi } from "../signals/check-api.js";
import { checkDatabase } from "../signals/check-database.js";
import { checkRedis } from "../signals/check-redis.js";
import { checkQueue } from "../signals/check-queue.js";
import { checkDisk } from "../signals/check-disk.js";
import { checkMemory } from "../signals/check-memory.js";
import { aggregateReport } from "../signals/aggregate-report.js";

export const fullHealthCheck = broadcast("full-health-check")
  .input(initHealthCheck)
  .then(checkApi, checkDatabase, checkRedis, checkQueue, checkDisk, checkMemory)
  .then(aggregateReport)
  .onFailure("continue")
  .timeout(30_000)
  .build();`}</Code>

      <h4>signals/check-api.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const checkApi = signal("check-api")
  .output(z.object({
    service: z.string(),
    healthy: z.boolean(),
    latencyMs: z.number(),
    checkedAt: z.string(),
  }))
  .every("5s")
  .run(async () => {
    const latencyMs = 20 + Math.floor(Math.random() * 80);
    await new Promise((r) => setTimeout(r, latencyMs));

    if (Math.random() < 0.1) {
      throw new Error(\`API responded with 503 (latency: \${latencyMs}ms)\`);
    }

    console.log(\`[check-api] OK \${latencyMs}ms\`);
    return {
      service: "api-gateway",
      healthy: true,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
  });`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { fullHealthCheck } from "./broadcasts/full-health-check.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
  maxConcurrent: 8,
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: new BroadcastSqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

broadcastRunner.register(fullHealthCheck);

console.log("Fleet monitor started.");
console.log("6 recurring health checks running at different intervals.");
console.log(\`Data persisted in \${DB_PATH}\`);
console.log("Open Station to watch real-time service health.\\n");

// Trigger a full health check broadcast every 60 seconds
setInterval(async () => {
  const id = await fullHealthCheck.trigger({
    label: \`scheduled-\${Date.now().toString(36)}\`,
  });
  console.log(\`\\n[broadcast] Triggered full health check: \${id}\\n\`);
}, 60_000);

// Also trigger one immediately after startup
setTimeout(async () => {
  const id = await fullHealthCheck.trigger({ label: "startup-check" });
  console.log(\`\\n[broadcast] Triggered startup health check: \${id}\\n\`);
}, 1000);

signalRunner.start();
broadcastRunner.start();`}</Code>

      <div className="info-box">
        <p>
          <code>onFailure(&quot;continue&quot;)</code> keeps checking remaining services even
          if one health check throws. Each check signal also runs independently on
          its own <code>.every()</code> interval. The broadcast adds a coordinated
          sweep that fans out all six checks in parallel and funnels results into a
          single aggregate report. Use <code>setInterval</code> to trigger the
          broadcast periodically.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-fleet-monitor start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
