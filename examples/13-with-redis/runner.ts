import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { RedisAdapter } from "station-adapter-redis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

const adapter = new RedisAdapter({ url });

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

console.log(`Connected to Redis: ${url}`);
console.log("Trigger a run from trigger.ts while this is running.");
await runner.start();
