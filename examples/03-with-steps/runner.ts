import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { processOrder } from "./signals/process-order.js";

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  subscribers: [
    new ConsoleSubscriber(),
    {
      onStepCompleted({ run, step }) {
        console.log(`  ✓ step "${step.name}" done (run ${run.id})`);
      },
    },
  ],
});

setTimeout(async () => {
  const id = await processOrder.trigger({ orderId: "ORD-42", amount: 99.99 });
  console.log(`[trigger] Enqueued run: ${id}`);
}, 500);

await runner.start();
