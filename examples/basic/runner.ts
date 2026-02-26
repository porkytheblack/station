import { ConsoleSubscriber, SignalRunner } from "simple-signal";
import { greet } from "./signals/greet.js";

const runner = new SignalRunner({
  signalsDir: "./examples/basic/signals",
  subscribers: [new ConsoleSubscriber()],
});

console.log("[runner] Starting...");

// Trigger a signal in-process (MemoryAdapter is process-local)
// For cross-process triggering, use a persistent adapter like SqliteAdapter.
setTimeout(async () => {
  const id = await greet.trigger({ name: "World" });
  console.log(`[trigger] Enqueued entry: ${id}`);
}, 500);

await runner.start();
