import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "Recurring — Examples — Station",
};

export default function RecurringExamplePage() {
  return (
    <>
      <div className="eyebrow">Examples</div>
      <h2 style={{ marginTop: 0 }}>Recurring</h2>
      <p>
        Signals that fire on a schedule without manual triggers.
      </p>

      <h4>signals/heartbeat.ts</h4>
      <Code>{`import { signal } from "station-signal";

export const heartbeat = signal("heartbeat")
  .every("5s")
  .run(async () => {
    console.log(\`[heartbeat] ping at \${new Date().toISOString()}\`);
  });`}</Code>

      <div className="info-box">
        <p>
          No input schema needed for recurring signals. <code>.every("5s")</code>{" "}
          schedules the signal to run every 5 seconds. The runner handles
          re-enqueuing after each execution.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-recurring start</code>
      </p>

      <hr className="divider" />
      <p><Link href="/docs/examples">&larr; All examples</Link></p>
    </>
  );
}
