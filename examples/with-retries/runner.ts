import { SignalRunner } from "simple-signal";

const runner = new SignalRunner({
  signalsDir: "./examples/with-retries/signals",
});

console.log("[runner] Starting (retries example)...");
await runner.start();
