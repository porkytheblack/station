import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { PostgresAdapter } from "station-adapter-postgres";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/station";

const adapter = new PostgresAdapter({ connectionString });

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

console.log(`Connected to PostgreSQL: ${connectionString}`);
console.log("Trigger a run from trigger.ts while this is running.");
await runner.start();
