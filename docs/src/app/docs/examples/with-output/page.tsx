import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "With Output — Examples — Station",
};

export default function WithOutputExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>With Output</h2>
      <p>
        Signals that return typed values and react to completion.
      </p>

      <h4>signals/add.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const add = signal("add")
  .input(z.object({ a: z.number(), b: z.number() }))
  .output(z.number())
  .run(async (input) => {
    const sum = input.a + input.b;
    console.log(\`\${input.a} + \${input.b} = \${sum}\`);
    return sum;
  })
  .onComplete(async (output, input) => {
    console.log(\`[onComplete] add(\${input.a}, \${input.b}) returned \${output}\`);
  });`}</Code>

      <div className="info-box">
        <p>
          <code>.output()</code> validates the return value against a Zod schema.{" "}
          <code>.onComplete()</code> fires after successful execution with the
          output and original input.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-with-output start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
