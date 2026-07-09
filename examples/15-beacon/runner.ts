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

await runner.start();
