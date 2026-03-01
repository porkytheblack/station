import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "With Steps — Examples — Station",
};

export default function WithStepsExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>With Steps</h2>
      <p>
        Multi-step signals where each step&apos;s output pipes to the next.
      </p>

      <h4>signals/process-order.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const processOrder = signal("processOrder")
  .input(z.object({ orderId: z.string(), amount: z.number() }))
  .timeout(30_000)
  .step("validate", async (input) => {
    console.log(\`[validate] Checking order \${input.orderId}...\`);
    if (input.amount <= 0) throw new Error("Invalid amount");
    return { orderId: input.orderId, amount: input.amount, validated: true };
  })
  .step("charge", async (prev) => {
    console.log(\`[charge] Charging $\${prev.amount} for order \${prev.orderId}...\`);
    await new Promise((r) => setTimeout(r, 500));
    const chargeId = \`ch_\${Math.random().toString(36).slice(2, 10)}\`;
    return { orderId: prev.orderId, chargeId };
  })
  .step("fulfill", async (prev) => {
    console.log(\`[fulfill] Fulfilling order \${prev.orderId} (charge: \${prev.chargeId})...\`);
    await new Promise((r) => setTimeout(r, 300));
    return { orderId: prev.orderId, status: "fulfilled", chargeId: prev.chargeId };
  })
  .build();`}</Code>

      <h4>runner.ts (relevant parts)</h4>
      <Code>{`const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  subscribers: [
    new ConsoleSubscriber(),
    {
      onStepCompleted({ run, step }) {
        console.log(\`  step "\${step.name}" done (run \${run.id})\`);
      },
    },
  ],
});`}</Code>

      <div className="info-box">
        <p>
          <code>.step()</code> chains sequential operations. Each step receives the
          previous step&apos;s return value. Use <code>.build()</code> instead of{" "}
          <code>.run()</code> when using steps. The <code>onStepCompleted</code>{" "}
          subscriber hook fires after each step finishes.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-with-steps start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
