import { SignalRunner } from "simple-signal";

const runner = SignalRunner.create("./examples/04-recurring/signals");

console.log("Heartbeat fires every 5 seconds. Each execution is a new Run.");
await runner.start();
