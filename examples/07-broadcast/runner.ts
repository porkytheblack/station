import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { orderPipeline } from "./broadcasts/order-pipeline.js";

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  subscribers: [new ConsoleBroadcastSubscriber()],
});

// Register the broadcast definition
broadcastRunner.register(orderPipeline);

// Trigger the broadcast after a short delay
setTimeout(async () => {
  const broadcastRunId = await orderPipeline.trigger({
    orderId: "ORD-42",
    amount: 99.99,
  });
  console.log(`\nTriggered broadcast: ${broadcastRunId}\n`);

  // Wait for completion
  const result = await broadcastRunner.waitForBroadcastRun(broadcastRunId, { timeoutMs: 30_000 });
  console.log(`\nBroadcast finished: ${result?.status}\n`);

  // Stop everything
  await broadcastRunner.stop();
  await signalRunner.stop();
}, 500);

// Start both runners (long-running loops, don't await at top level)
signalRunner.start();
broadcastRunner.start();
