import { SignalRunner, ConsoleSubscriber } from "simple-signal";
import { processOrder } from "./signals/process-order.js";

const runner = new SignalRunner({
  signalsDir: "./examples/03-with-steps/signals",
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
