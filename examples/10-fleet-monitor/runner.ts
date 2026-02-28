import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "simple-broadcast";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";
import { BroadcastSqliteAdapter } from "@simple-signal/adapter-sqlite/broadcast";
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
console.log(`Data persisted in ${DB_PATH}`);
console.log("Open Station to watch real-time service health.\n");

// Trigger a full health check broadcast every 60 seconds
setInterval(async () => {
  const id = await fullHealthCheck.trigger({ label: `scheduled-${Date.now().toString(36)}` });
  console.log(`\n[broadcast] Triggered full health check: ${id}\n`);
}, 60_000);

// Also trigger one immediately after startup
setTimeout(async () => {
  const id = await fullHealthCheck.trigger({ label: "startup-check" });
  console.log(`\n[broadcast] Triggered startup health check: ${id}\n`);
}, 1000);

signalRunner.start();
broadcastRunner.start();
