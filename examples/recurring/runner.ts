import { SignalRunner } from "simple-signal";

const runner = new SignalRunner({
  signalsDir: "./examples/recurring/signals",
});

console.log("[runner] Starting (recurring example)...");
console.log("[runner] Heartbeat will fire every 5 seconds.");
runner.subscribe({
  onLogOutput({ entry, level, message }) {
    console.log(`[runner] ${entry.id} ${level}: ${message}`);
  },
  onEntryStarted({entry}) {
    console.log(`[runner] Entry ${entry.id} started`);
  },
  onEntryCompleted({entry}) {
    console.log(`[runner] Entry ${entry.id} completed`);
  },
  onEntryFailed({entry}) {
    console.log("entry failed::", entry.id)
  },
  onEntryRetry({entry}) {
    console.log(entry)
  },
  
});
await runner.start();
