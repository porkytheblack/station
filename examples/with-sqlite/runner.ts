import { SignalRunner } from "simple-signal";
import { fileURLToPath } from "node:url";

const runner = new SignalRunner({
  signalsDir: "./examples/with-sqlite/signals",
  configModule: fileURLToPath(new URL("./adapter.config.ts", import.meta.url)),
});

console.log("[runner] Starting (SQLite example)...");
console.log("[runner] Entries are persisted in examples/with-sqlite/jobs.db");
await runner.start();
