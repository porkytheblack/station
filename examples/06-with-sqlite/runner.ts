import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
});

console.log(`Runs are persisted in ${DB_PATH}`);
console.log("Trigger a run from trigger.ts while this is running.");
await runner.start();
