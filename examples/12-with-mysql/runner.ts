import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { MysqlAdapter } from "station-adapter-mysql";

const connectionString = process.env.DATABASE_URL ?? "mysql://root@localhost:3306/station";

const adapter = await MysqlAdapter.create({ connectionString });

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

console.log(`Connected to MySQL: ${connectionString}`);
console.log("Trigger a run from trigger.ts while this is running.");
await runner.start();
