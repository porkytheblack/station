import path from "node:path";
import { SignalRunner } from "simple-signal";

const runner = SignalRunner.create(path.join(import.meta.dirname, "signals"));

console.log("Heartbeat fires every 5 seconds. Each execution is a new Run.");
await runner.start();
