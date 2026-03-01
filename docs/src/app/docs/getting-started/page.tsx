import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata = { title: "Getting Started — Station" };

export default function GettingStartedPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Getting started</h2>
      <p>
        This guide walks through Station from first install to a production-ready
        setup with persistence, recurring jobs, multi-step pipelines, and lifecycle
        observers.
      </p>

      {/* ── Prerequisites ── */}

      <h3>Prerequisites</h3>
      <ul>
        <li>Node.js 18 or later</li>
        <li>A package manager (pnpm, npm, or yarn)</li>
        <li>
          A TypeScript project configured for ES modules (<code>{`"type": "module"`}</code> in
          your package.json)
        </li>
      </ul>

      <hr className="divider" />

      {/* ── 1. Install ── */}

      <h3>1. Install</h3>
      <Code>{`pnpm add station-signal`}</Code>
      <div className="info-box">
        <p>
          station-signal re-exports <code>z</code> from Zod. There is no need to
          install Zod separately.
        </p>
      </div>

      <hr className="divider" />

      {/* ── 2. Define a signal ── */}

      <h3>2. Define a signal</h3>
      <p>
        A signal is a named, type-safe background job definition. It declares an
        input schema, execution constraints, and a handler function using a
        builder pattern. Signals are defined in their own files so the runner can
        auto-discover them.
      </p>
      <Code>{`// signals/send-email.ts
import { signal, z } from "station-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({
    to: z.string(),
    subject: z.string(),
    body: z.string(),
  }))
  .timeout(30_000)
  .retries(2)
  .run(async (input) => {
    console.log(\`Sending email to \${input.to}\`);
    // Your email sending logic here
  });`}</Code>

      <h4>Builder methods</h4>
      <table className="api-table">
        <thead>
          <tr>
            <th>Method</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>.input(schema)</code></td>
            <td>
              Zod schema for the job payload. Every <code>.trigger()</code> call
              is validated against this schema. If validation fails, the run
              never starts.
            </td>
          </tr>
          <tr>
            <td><code>.timeout(30_000)</code></td>
            <td>
              Maximum execution time in milliseconds. If the handler exceeds
              this duration, the run is killed and marked as timed out.
              Default: <code>300_000</code> (5 minutes).
            </td>
          </tr>
          <tr>
            <td><code>.retries(2)</code></td>
            <td>
              Number of retry attempts after the initial failure. A value
              of <code>2</code> means 3 total attempts (1 initial + 2 retries).
              Default: <code>0</code> (no retry).
            </td>
          </tr>
          <tr>
            <td><code>.run(handler)</code></td>
            <td>
              The handler function. Receives the validated input. Runs in an
              isolated child process spawned by the runner.
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── 3. Create the runner ── */}

      <h3>3. Create the runner</h3>
      <p>
        The runner is the process that polls for due jobs and spawns child
        processes to execute them. Point it at a directory of signal files and
        call <code>start()</code>.
      </p>
      <Code>{`// runner.ts
import path from "node:path";
import { SignalRunner } from "station-signal";

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
});

runner.start();`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Option</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>signalsDir</code></td>
            <td>
              Path to a directory of signal files. The runner auto-discovers
              every <code>.ts</code> or <code>.js</code> file that exports a
              signal and registers it at startup.
            </td>
          </tr>
          <tr>
            <td><code>runner.start()</code></td>
            <td>
              Begins the poll loop. The runner checks for due entries every
              second by default. Configurable via the <code>pollInterval</code> option
              (in milliseconds).
            </td>
          </tr>
        </tbody>
      </table>

      <div className="warn-box">
        <p>
          By default, the runner uses an in-memory adapter. All jobs are lost on
          restart. See <strong>step 5</strong> below for production-grade persistence.
        </p>
      </div>

      <hr className="divider" />

      {/* ── 4. Trigger a signal ── */}

      <h3>4. Trigger a signal</h3>
      <Code>{`import { sendEmail } from "./signals/send-email.js";

const runId = await sendEmail.trigger({
  to: "user@example.com",
  subject: "Welcome",
  body: "Thanks for signing up.",
});

console.log(\`Enqueued run: \${runId}\`);`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Behavior</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Validation</td>
            <td>
              <code>.trigger()</code> validates the input against the Zod schema
              before enqueuing. Invalid input throws immediately.
            </td>
          </tr>
          <tr>
            <td>Return value</td>
            <td>
              Returns a run ID (string) immediately. The call does not wait for
              execution.
            </td>
          </tr>
          <tr>
            <td>Execution</td>
            <td>
              The runner picks up the job on its next poll tick and spawns a
              child process to run the handler.
            </td>
          </tr>
        </tbody>
      </table>

      <div className="info-box">
        <p>
          The <code>.js</code> extension in the import path is required for ESM
          resolution, even when your source files are <code>.ts</code>.
        </p>
      </div>

      <hr className="divider" />

      {/* ── 5. Add persistence (SQLite) ── */}

      <h3>5. Add persistence (SQLite)</h3>
      <p>
        The default in-memory adapter loses all jobs on process restart. For
        anything beyond local development, use the SQLite adapter.
      </p>
      <Code>{`pnpm add station-adapter-sqlite`}</Code>
      <Code>{`// runner.ts
import path from "node:path";
import { SignalRunner } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({
    dbPath: path.join(import.meta.dirname, "jobs.db"),
  }),
});

runner.start();`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Detail</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Engine</td>
            <td>
              Uses better-sqlite3 under the hood with WAL mode enabled for
              concurrent reads.
            </td>
          </tr>
          <tr>
            <td>Setup</td>
            <td>
              Tables and indexes are created automatically on first run. No
              migrations needed.
            </td>
          </tr>
          <tr>
            <td>Database file</td>
            <td>
              Created at the path you provide. Use an absolute path to avoid
              ambiguity.
            </td>
          </tr>
        </tbody>
      </table>

      <h4>Shared adapter for separate processes</h4>
      <p>
        When triggers happen in a different process than the runner (common in
        web servers), both processes need access to the same adapter instance.
        Use the <code>configure()</code> function to set a global default.
      </p>
      <Code>{`// config.ts
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

configure({
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
});`}</Code>
      <p>
        Import the config module before any signal imports in your trigger
        process:
      </p>
      <Code>{`// In your web server or trigger process
import "./config.js"; // Run configure() first
import { sendEmail } from "./signals/send-email.js";

await sendEmail.trigger({
  to: "user@example.com",
  subject: "Order confirmation",
  body: "Your order has been placed.",
});`}</Code>

      <hr className="divider" />

      {/* ── 6. Recurring signals ── */}

      <h3>6. Recurring signals</h3>
      <p>
        Signals can run on a fixed interval. The runner handles scheduling,
        re-enqueuing, and retry logic automatically.
      </p>
      <Code>{`// signals/health-check.ts
import { signal } from "station-signal";

export const healthCheck = signal("healthCheck")
  .every("5m")
  .run(async () => {
    const res = await fetch("https://api.example.com/health");
    if (!res.ok) throw new Error(\`Health check failed: \${res.status}\`);
  });`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Behavior</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Intervals</td>
            <td>
              <code>.every()</code> accepts interval
              strings: <code>{`"30s"`}</code>, <code>{`"5m"`}</code>, <code>{`"1h"`}</code>, <code>{`"1d"`}</code>.
            </td>
          </tr>
          <tr>
            <td>Scheduling</td>
            <td>
              The runner automatically schedules the first execution at startup
              and re-enqueues after each completion.
            </td>
          </tr>
          <tr>
            <td>Input</td>
            <td>
              No input schema needed for recurring signals. If your recurring
              signal requires input, chain <code>.withInput(data)</code> to
              provide a default payload.
            </td>
          </tr>
          <tr>
            <td>Failures</td>
            <td>
              If a recurring signal fails, retry rules apply. After all attempts
              are exhausted, it re-enqueues for the next interval.
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── 7. Multi-step signals ── */}

      <h3>7. Multi-step signals</h3>
      <p>
        For pipelines where each stage transforms data for the next, use steps
        instead of a single handler.
      </p>
      <Code>{`// signals/process-order.ts
import { signal, z } from "station-signal";

export const processOrder = signal("processOrder")
  .input(z.object({ orderId: z.string(), amount: z.number() }))
  .step("validate", async (input) => {
    if (input.amount <= 0) throw new Error("Invalid amount");
    return { ...input, validated: true };
  })
  .step("charge", async (prev) => {
    const chargeId = await payments.charge(prev.amount);
    return { orderId: prev.orderId, chargeId };
  })
  .step("notify", async (prev) => {
    await notify(\`Order \${prev.orderId} charged: \${prev.chargeId}\`);
  })
  .build();`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Behavior</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Data flow</td>
            <td>
              Each <code>.step()</code> receives the return value of the
              previous step as its input. The first step receives the
              validated signal input.
            </td>
          </tr>
          <tr>
            <td>Execution</td>
            <td>
              Steps run sequentially within a single child process.
            </td>
          </tr>
          <tr>
            <td>Failure</td>
            <td>
              If any step throws, the entire run fails and retries from the
              beginning (if retries are configured).
            </td>
          </tr>
          <tr>
            <td>Finalization</td>
            <td>
              Use <code>.build()</code> instead of <code>.run()</code> when
              defining steps.
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="divider" />

      {/* ── 8. Subscribers ── */}

      <h3>8. Subscribers</h3>
      <p>
        Subscribers observe the signal lifecycle. Use them for logging, metrics,
        alerting, or any side effect that should not live inside a handler.
      </p>
      <Code>{`import { SignalRunner, ConsoleSubscriber } from "station-signal";

const runner = new SignalRunner({
  signalsDir: "./signals",
  subscribers: [
    new ConsoleSubscriber(), // Built-in: logs all events to stdout
    {
      onStart(run) {
        metrics.increment("signal.started", { name: run.signalName });
      },
      onComplete(run) {
        metrics.increment("signal.completed", { name: run.signalName });
      },
      onFail(run, error) {
        alerting.send(\`Signal \${run.signalName} failed: \${error}\`);
      },
    },
  ],
});`}</Code>

      <table className="api-table">
        <thead>
          <tr>
            <th>Event</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>onEnqueue</code></td>
            <td>A run was added to the queue.</td>
          </tr>
          <tr>
            <td><code>onStart</code></td>
            <td>A child process began executing the handler.</td>
          </tr>
          <tr>
            <td><code>onComplete</code></td>
            <td>The handler finished successfully.</td>
          </tr>
          <tr>
            <td><code>onFail</code></td>
            <td>The handler threw an error (after all retries exhausted).</td>
          </tr>
          <tr>
            <td><code>onRetry</code></td>
            <td>A failed run is being retried.</td>
          </tr>
          <tr>
            <td><code>onTimeout</code></td>
            <td>The handler exceeded its timeout and was killed.</td>
          </tr>
        </tbody>
      </table>

      <div className="info-box">
        <p>
          All subscriber methods are optional. Implement only the events you
          care about. <code>ConsoleSubscriber</code> is a built-in subscriber
          that logs every event to stdout.
        </p>
      </div>

      <hr className="divider" />

      {/* ── Next steps ── */}

      <h3>Next steps</h3>
      <table className="api-table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><Link href="/docs/signals">Signals API</Link></td>
            <td>Full builder reference, runner options, adapter interface.</td>
          </tr>
          <tr>
            <td><Link href="/docs/broadcasts">Broadcasts</Link></td>
            <td>Chain signals into DAG workflows with fan-out and fan-in.</td>
          </tr>
          <tr>
            <td><Link href="/docs/adapters">Adapters</Link></td>
            <td>SQLite adapter details and custom adapter interface.</td>
          </tr>
          <tr>
            <td><Link href="/docs/station">Station</Link></td>
            <td>Real-time monitoring dashboard for signals and broadcasts.</td>
          </tr>
          <tr>
            <td><Link href="/docs/examples">Examples</Link></td>
            <td>Complete working examples covering common patterns.</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
