import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "Broadcast — Examples — Station",
};

export default function BroadcastExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>Broadcast</h2>
      <p>
        DAG workflow orchestration. Chain signals into a dependency graph with
        fan-out and conditional execution.
      </p>

      <h4>signals/validate-order.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const validateOrder = signal("validate-order")
  .input(z.object({ orderId: z.string(), amount: z.number() }))
  .output(z.object({ orderId: z.string(), amount: z.number(), valid: z.boolean() }))
  .run(async (input) => {
    console.log(\`Validating order \${input.orderId} ($\${input.amount})\`);
    return { orderId: input.orderId, amount: input.amount, valid: input.amount > 0 };
  });`}</Code>

      <h4>signals/charge-payment.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const chargePayment = signal("charge-payment")
  .input(z.object({ orderId: z.string(), amount: z.number(), valid: z.boolean() }))
  .output(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    const chargeId = \`ch_\${Math.random().toString(36).slice(2, 8)}\`;
    console.log(\`Charging $\${input.amount} for order \${input.orderId}\`);
    return { orderId: input.orderId, chargeId };
  });`}</Code>

      <h4>signals/send-receipt.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const sendReceipt = signal("send-receipt")
  .input(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    console.log(\`Sending receipt for order \${input.orderId} (charge: \${input.chargeId})\`);
  });`}</Code>

      <h4>signals/notify-warehouse.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const notifyWarehouse = signal("notify-warehouse")
  .input(z.object({ orderId: z.string(), chargeId: z.string() }))
  .run(async (input) => {
    console.log(\`Notifying warehouse for order \${input.orderId}\`);
  });`}</Code>

      <h4>broadcasts/order-pipeline.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { validateOrder } from "../signals/validate-order.js";
import { chargePayment } from "../signals/charge-payment.js";
import { sendReceipt } from "../signals/send-receipt.js";
import { notifyWarehouse } from "../signals/notify-warehouse.js";

export const orderPipeline = broadcast("order-pipeline")
  .input(validateOrder)
  .then(chargePayment, {
    when: (prev) => (prev["validate-order"] as { valid: boolean }).valid === true,
  })
  .then(sendReceipt, notifyWarehouse) // fan-out: both run in parallel
  .build();`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
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

broadcastRunner.register(orderPipeline);

setTimeout(async () => {
  const broadcastRunId = await orderPipeline.trigger({
    orderId: "ORD-42",
    amount: 99.99,
  });
  console.log(\`\\nTriggered broadcast: \${broadcastRunId}\\n\`);

  const result = await broadcastRunner.waitForBroadcastRun(broadcastRunId, {
    timeoutMs: 30_000,
  });
  console.log(\`\\nBroadcast finished: \${result?.status}\\n\`);

  await broadcastRunner.stop();
  await signalRunner.stop();
}, 500);

signalRunner.start();
broadcastRunner.start();`}</Code>

      <div className="info-box">
        <p>
          <code>broadcast()</code> creates a DAG. <code>.input()</code> sets the
          entry signal. <code>.then()</code> adds downstream nodes. Multiple signals
          in one <code>.then()</code> = fan-out (parallel). <code>when</code> is a
          guard that returns false to skip a node. <code>BroadcastRunner</code>{" "}
          orchestrates the DAG. <code>waitForBroadcastRun</code> blocks until
          completion.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-broadcast start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
