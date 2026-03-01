import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "Basic — Examples — Station",
};

export default function BasicExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>Basic</h2>
      <p>
        The simplest signal. Define it, trigger it, done.
      </p>

      <h4>signals/greet.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const greet = signal("greet")
  .input(z.object({ name: z.string() }))
  .every("5s")
  .run(async (input) => {
    console.log(\`Hello, \${input.name}!\`);
  });`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner } from "station-signal";
import { greet } from "./signals/greet.js";

const runner = SignalRunner.create(path.join(import.meta.dirname, "signals"));

setTimeout(async () => {
  const id = await greet.trigger({ name: "World" });
  console.log(\`[trigger] Enqueued run: \${id}\`);
}, 500);

await runner.start();`}</Code>

      <div className="info-box">
        <p>
          <code>signal()</code> creates a named job. <code>.input()</code> sets a
          Zod schema for validation. <code>.every("5s")</code> makes it recurring.{" "}
          <code>.run()</code> defines the handler. <code>SignalRunner.create()</code> is
          a shorthand that auto-discovers all signals exported from files in a directory.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-basic start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
