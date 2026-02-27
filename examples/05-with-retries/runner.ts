import { SignalRunner } from "simple-signal";
import { flakyTask } from "./signals/flaky-task.js";

const runner = SignalRunner.create("./examples/05-with-retries/signals");

setTimeout(async () => {
  const id = await flakyTask.trigger({ message: "important work" });
  console.log(`[trigger] Enqueued run: ${id}`);
  console.log("[trigger] 60% failure rate with 3 retries (4 total attempts).");
}, 500);

await runner.start();
