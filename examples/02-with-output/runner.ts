import path from "node:path";
import { SignalRunner } from "simple-signal";
import { add } from "./signals/add.js";

const runner = SignalRunner.create(path.join(import.meta.dirname, "signals"));

setTimeout(async () => {
  const id = await add.trigger({ a: 3, b: 7 });
  console.log(`[trigger] Enqueued run: ${id}`);
}, 500);

await runner.start();
