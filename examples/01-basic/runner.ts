import { SignalRunner } from "simple-signal";
import { greet } from "./signals/greet.js";

const runner = SignalRunner.create("./examples/01-basic/signals");

// Trigger in-process after a short delay (MemoryAdapter is process-local)
setTimeout(async () => {
  const id = await greet.trigger({ name: "World" });
  console.log(`[trigger] Enqueued run: ${id}`);
}, 500);

await runner.start();
