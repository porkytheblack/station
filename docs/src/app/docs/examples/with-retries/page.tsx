import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "With Retries — Examples — Station",
};

export default function WithRetriesExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>With Retries</h2>
      <p>
        Automatic retry behavior for flaky operations.
      </p>

      <h4>signals/flaky-task.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const flakyTask = signal("flakyTask")
  .input(z.object({ message: z.string() }))
  .timeout(3_000)
  .retries(3)
  .run(async (input) => {
    const shouldFail = Math.random() < 0.6;

    if (shouldFail) {
      console.log(\`[flakyTask] "\${input.message}" — failed! (will retry)\`);
      throw new Error("Random failure");
    }

    console.log(\`[flakyTask] "\${input.message}" — success!\`);
  });`}</Code>

      <div className="info-box">
        <p>
          <code>.retries(3)</code> means 4 total attempts (1 initial + 3 retries).{" "}
          <code>.timeout(3_000)</code> kills the handler after 3 seconds. With a 60%
          failure rate, the signal almost always succeeds within 4 attempts.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-with-retries start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
