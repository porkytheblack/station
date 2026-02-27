import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";

const DB_PATH = "./examples/06-with-sqlite/jobs.db";

const runner = new SignalRunner({
  signalsDir: "./examples/06-with-sqlite/signals",
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
});

console.log(`Runs are persisted in ${DB_PATH}`);
console.log("Trigger a run from trigger.ts while this is running.");
await runner.start();
