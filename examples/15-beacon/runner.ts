import path from "node:path";
import { BeaconRunner, ConsoleBeaconSubscriber } from "station-beacon";

const runner = BeaconRunner.create(path.join(import.meta.dirname, "beacons"), {
  subscribers: [new ConsoleBeaconSubscriber()],
  pollIntervalMs: 500,
});

console.log("Supervising three beacons:");
console.log("  • health-server  — an HTTP server on :8099 (restart: always)");
console.log("  • uptime-poller  — polls the server every 3s (poll mode)");
console.log("  • stream-client  — a flaky client that reconnects with backoff\n");
console.log("Watch the client drop and get restarted. Press Ctrl-C to stop.\n");

runner.start().catch((err) => {
  console.error("[example] beacon runner failed:", err);
});

// start() only settles when the supervisor stops, so wait for the setup phase
// (discovery + instance hydration) before creating instances against it.
await runner.whenReady();

// queue-worker is on-demand: nothing runs until an instance is created. Here we
// spin up two from code — the dashboard and the API create them the same way.
for (const queue of ["billing", "emails"]) {
  await runner.createInstance("queue-worker", {
    id: `worker-${queue}`,
    label: `${queue} queue`,
    config: { queue, batchSize: queue === "billing" ? 25 : 5 },
  });
}
console.log("Created two queue-worker instances: worker-billing, worker-emails\n");
