import { SignalRunner } from "simple-signal";
import { add } from "./signals/add.js";

const runner = SignalRunner.create("./examples/02-with-output/signals");

setTimeout(async () => {
  const id = await add.trigger({ a: 3, b: 7 });
  console.log(`[trigger] Enqueued run: ${id}`);
}, 500);

await runner.start();
