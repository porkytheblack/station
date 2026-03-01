import { Metadata } from "next";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Examples — Station",
};

export default function ExamplesPage() {
  return (
    <>
      <div className="eyebrow">Showcase</div>
      <h2 style={{ marginTop: 0 }}>Examples</h2>
      <p>
        Ten working examples from a single signal to full production workflows.
        Each one runs standalone with <code>pnpm start</code>.
      </p>

      {/* ── 01 Basic ── */}
      <hr className="divider" />
      <h3>01 — Basic</h3>
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

      {/* ── 02 With Output ── */}
      <hr className="divider" />
      <h3>02 — With Output</h3>
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

      {/* ── 03 With Steps ── */}
      <hr className="divider" />
      <h3>03 — With Steps</h3>
      <p>
        Multi-step signals where each step's output pipes to the next.
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
          previous step's return value. Use <code>.build()</code> instead of{" "}
          <code>.run()</code> when using steps. The <code>onStepCompleted</code>{" "}
          subscriber hook fires after each step finishes.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-with-steps start</code>
      </p>

      {/* ── 04 Recurring ── */}
      <hr className="divider" />
      <h3>04 — Recurring</h3>
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

      {/* ── 05 With Retries ── */}
      <hr className="divider" />
      <h3>05 — With Retries</h3>
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

      {/* ── 06 With SQLite ── */}
      <hr className="divider" />
      <h3>06 — With SQLite</h3>
      <p>
        Persistent storage with separate trigger and runner processes. The pattern
        used by web applications: the API server enqueues jobs, a background worker
        processes them.
      </p>

      <h4>signals/send-email.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const sendEmail = signal("sendEmail")
  .input(z.object({ to: z.string(), subject: z.string(), body: z.string() }))
  .timeout(10_000)
  .step("validate", async (input) => {
    console.log(\`[validate] Checking email to \${input.to}...\`);
    if (!input.to.includes("@")) throw new Error("Invalid email address");
    return input;
  })
  .step("send", async (email) => {
    console.log(\`[send] Sending "\${email.subject}" to \${email.to}...\`);
    await new Promise((r) => setTimeout(r, 500));
    const messageId = \`msg_\${Math.random().toString(36).slice(2, 10)}\`;
    console.log(\`[send] Sent! Message ID: \${messageId}\`);
    return { messageId };
  })
  .build();`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
});

await runner.start();`}</Code>

      <h4>trigger.ts</h4>
      <Code>{`import path from "node:path";
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";
import { sendEmail } from "./signals/send-email.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");
configure({ adapter: new SqliteAdapter({ dbPath: DB_PATH }) });

const id = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Hello from station-signal",
  body: "This run was persisted to SQLite.",
});

console.log(\`Run triggered: \${id}\`);`}</Code>

      <div className="info-box">
        <p>
          <code>SqliteAdapter</code> persists runs to disk. <code>configure()</code>{" "}
          sets a global adapter so triggers from other processes write to the same
          database. Run the runner in one terminal, then trigger from another. The
          runner picks up the persisted job and executes it.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-with-sqlite start</code>
      </p>

      {/* ── 07 Broadcast ── */}
      <hr className="divider" />
      <h3>07 — Broadcast</h3>
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

      {/* ── 08 ETL Pipeline ── */}
      <hr className="divider" />
      <h3>08 — ETL Pipeline</h3>
      <p>
        Extract-transform-load workflow with multi-step signals. A linear
        broadcast chain: extract, transform, load, report. Each signal's output
        becomes the next signal's input.
      </p>

      <h4>broadcasts/etl-pipeline.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { extractUsers } from "../signals/extract-users.js";
import { transformUsers } from "../signals/transform-users.js";
import { loadUsers } from "../signals/load-users.js";
import { generateReport } from "../signals/generate-report.js";

export const etlPipeline = broadcast("etl-pipeline")
  .input(extractUsers)
  .then(transformUsers)
  .then(loadUsers)
  .then(generateReport)
  .timeout(60_000)
  .build();`}</Code>

      <h4>signals/extract-users.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const extractUsers = signal("extract-users")
  .input(z.object({ source: z.string(), batchSize: z.number() }))
  .output(
    z.object({
      records: z.array(z.object({ id: z.number(), name: z.string(), email: z.string() })),
      source: z.string(),
    }),
  )
  .timeout(15_000)
  .step("connect", async (input) => {
    console.log(\`[extract] Connecting to \${input.source}...\`);
    await new Promise((r) => setTimeout(r, 400));
    return { ...input, connected: true };
  })
  .step("query", async (prev) => {
    console.log(\`[extract] Querying \${prev.batchSize} records from \${prev.source}...\`);
    await new Promise((r) => setTimeout(r, 800));

    const records = Array.from({ length: prev.batchSize }, (_, i) => ({
      id: i + 1,
      name: \`User \${i + 1}\`,
      email: \`user\${i + 1}@\${prev.source}\`,
      raw_signup: \`2024-0\${(i % 9) + 1}-15\`,
      status_code: i % 3 === 0 ? "A" : i % 3 === 1 ? "I" : "P",
    }));
    console.log(\`[extract] Fetched \${records.length} records.\`);
    return { records, source: prev.source };
  })
  .step("validate", async (prev) => {
    console.log(\`[extract] Validating \${prev.records.length} records...\`);
    const valid = prev.records.filter((r: { email: string }) => r.email.includes("@"));
    const dropped = prev.records.length - valid.length;
    if (dropped > 0) console.log(\`[extract] Dropped \${dropped} invalid records.\`);
    return {
      records: valid.map((r: { id: number; name: string; email: string }) => ({
        id: r.id,
        name: r.name,
        email: r.email,
      })),
      source: prev.source,
    };
  })
  .build();`}</Code>

      <h4>signals/load-users.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

const userRecord = z.object({ id: z.number(), name: z.string(), email: z.string() });

export const loadUsers = signal("load-users")
  .input(
    z.object({
      records: z.array(userRecord),
      source: z.string(),
      transformedAt: z.string(),
    }),
  )
  .output(z.object({ inserted: z.number(), updated: z.number(), source: z.string() }))
  .timeout(20_000)
  .retries(2)
  .step("upsert", async (input) => {
    console.log(\`[load] Upserting \${input.records.length} records into target database...\`);
    await new Promise((r) => setTimeout(r, 600));

    if (Math.random() < 0.1) {
      throw new Error("Connection to target database lost");
    }

    const inserted = Math.floor(input.records.length * 0.7);
    const updated = input.records.length - inserted;
    console.log(\`[load] Inserted \${inserted}, updated \${updated}.\`);
    return { inserted, updated, source: input.source };
  })
  .step("verify", async (prev) => {
    console.log(\`[load] Verifying load integrity...\`);
    await new Promise((r) => setTimeout(r, 300));
    const total = prev.inserted + prev.updated;
    console.log(\`[load] Verified \${total} records in target.\`);
    return prev;
  })
  .build();`}</Code>

      <div className="info-box">
        <p>
          The extract signal uses three steps (connect, query, validate) to
          demonstrate multi-step signals within a broadcast. The load signal has{" "}
          <code>.retries(2)</code> to handle transient database failures. Each
          signal's final output shape must match the next signal's input schema.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-etl-pipeline start</code>
      </p>

      {/* ── 09 CI Pipeline ── */}
      <hr className="divider" />
      <h3>09 — CI Pipeline</h3>
      <p>
        Simulated CI/CD workflow with fan-out, branch guards, and result fallback.
        The most complex DAG in the examples.
      </p>

      <Code>{`checkout
  |---> lint              (parallel)
  |---> test-unit         (parallel, 2 retries)
  |---> test-integration  (parallel, 1 retry)
           |
        build-app         (waits for all above)
           |
      deploy-staging
           |
      deploy-prod         (guard: only on "main" branch)
           |
        notify            (fallback: uses staging output if prod skipped)`}</Code>

      <h4>broadcasts/ci-pipeline.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { checkout } from "../signals/checkout.js";
import { lint } from "../signals/lint.js";
import { testUnit } from "../signals/test-unit.js";
import { testIntegration } from "../signals/test-integration.js";
import { buildApp } from "../signals/build-app.js";
import { deployStaging } from "../signals/deploy-staging.js";
import { deployProd } from "../signals/deploy-prod.js";
import { notify } from "../signals/notify.js";

export const ciPipeline = broadcast("ci-pipeline")
  .input(checkout)
  .then(lint, testUnit, testIntegration) // fan-out: all run in parallel
  .then(buildApp, {
    // Wait for all tests AND checkout; pass checkout output as build input
    after: ["lint", "test-unit", "test-integration", "checkout"],
    map: (upstream) => upstream["checkout"],
  })
  .then(deployStaging)
  .then(deployProd, {
    // Need checkout data for the branch guard
    after: ["deploy-staging", "checkout"],
    map: (upstream) => upstream["deploy-staging"],
    when: (upstream) => {
      const co = upstream["checkout"] as { branch: string } | undefined;
      return co?.branch === "main";
    },
  })
  .then(notify, {
    // If deploy-prod was skipped (non-main branch), fall back to staging output
    after: ["deploy-prod", "deploy-staging"],
    map: (upstream) => upstream["deploy-prod"] ?? upstream["deploy-staging"],
  })
  .onFailure("fail-fast")
  .timeout(120_000)
  .build();`}</Code>

      <h4>signals/checkout.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const checkout = signal("checkout")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string() }))
  .output(z.object({
    repo: z.string(),
    branch: z.string(),
    commitSha: z.string(),
    workdir: z.string(),
  }))
  .timeout(10_000)
  .run(async (input) => {
    console.log(\`[checkout] Cloning \${input.repo}@\${input.branch} (\${input.commitSha.slice(0, 7)})...\`);
    await new Promise((r) => setTimeout(r, 600));
    const workdir = \`/tmp/ci/\${input.commitSha.slice(0, 7)}\`;
    console.log(\`[checkout] Workspace ready at \${workdir}\`);
    return { ...input, workdir };
  });`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { ciPipeline } from "./broadcasts/ci-pipeline.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
  maxConcurrent: 4,
  retryBackoffMs: 500,
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: new BroadcastSqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

broadcastRunner.register(ciPipeline);

const branch = process.argv[2] || "main";
const sha = Math.random().toString(36).slice(2, 10)
  + Math.random().toString(36).slice(2, 6);

setTimeout(async () => {
  const id = await ciPipeline.trigger({
    repo: "acme/web-app",
    branch,
    commitSha: sha,
  });

  console.log(\`\\nTriggered CI pipeline: \${id}\`);
  console.log(\`  repo:   acme/web-app\`);
  console.log(\`  branch: \${branch}\`);
  console.log(\`  commit: \${sha.slice(0, 7)}\`);
  console.log(\`\\nProd deploy \${branch === "main" ? "enabled" : "skipped"} (branch guard).\`);
}, 500);

signalRunner.start();
broadcastRunner.start();`}</Code>

      <div className="info-box">
        <p>
          <code>after</code> overrides implicit dependencies so <code>build-app</code>{" "}
          waits for all three parallel steps. <code>map</code> transforms upstream
          outputs into the shape the next signal expects. <code>when</code>{" "}
          conditionally skips nodes — here it gates prod deployment on the{" "}
          <code>"main"</code> branch. The <code>??</code> in notify's map provides a
          fallback when <code>deploy-prod</code> was skipped and returned undefined.{" "}
          <code>onFailure("fail-fast")</code> stops the entire pipeline on the first
          failure.
        </p>
      </div>

      <div className="warn-box">
        <p>
          Pass a branch name as a CLI argument to test the guard:{" "}
          <code>pnpm --filter example-ci-pipeline start -- feature/xyz</code>{" "}
          skips the prod deploy step.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-ci-pipeline start</code>
      </p>

      {/* ── 10 Fleet Monitor ── */}
      <hr className="divider" />
      <h3>10 — Fleet Monitor</h3>
      <p>
        Real-time service health monitoring. Six parallel health check signals
        fan out from an init signal and converge into an aggregate report.
        Triggered on a recurring 60-second interval.
      </p>

      <h4>broadcasts/full-health-check.ts</h4>
      <Code>{`import { broadcast } from "station-broadcast";
import { initHealthCheck } from "../signals/init-health-check.js";
import { checkApi } from "../signals/check-api.js";
import { checkDatabase } from "../signals/check-database.js";
import { checkRedis } from "../signals/check-redis.js";
import { checkQueue } from "../signals/check-queue.js";
import { checkDisk } from "../signals/check-disk.js";
import { checkMemory } from "../signals/check-memory.js";
import { aggregateReport } from "../signals/aggregate-report.js";

export const fullHealthCheck = broadcast("full-health-check")
  .input(initHealthCheck)
  .then(checkApi, checkDatabase, checkRedis, checkQueue, checkDisk, checkMemory)
  .then(aggregateReport)
  .onFailure("continue")
  .timeout(30_000)
  .build();`}</Code>

      <h4>signals/check-api.ts</h4>
      <Code>{`import { signal, z } from "station-signal";

export const checkApi = signal("check-api")
  .output(z.object({
    service: z.string(),
    healthy: z.boolean(),
    latencyMs: z.number(),
    checkedAt: z.string(),
  }))
  .every("5s")
  .run(async () => {
    const latencyMs = 20 + Math.floor(Math.random() * 80);
    await new Promise((r) => setTimeout(r, latencyMs));

    if (Math.random() < 0.1) {
      throw new Error(\`API responded with 503 (latency: \${latencyMs}ms)\`);
    }

    console.log(\`[check-api] OK \${latencyMs}ms\`);
    return {
      service: "api-gateway",
      healthy: true,
      latencyMs,
      checkedAt: new Date().toISOString(),
    };
  });`}</Code>

      <h4>runner.ts</h4>
      <Code>{`import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { fullHealthCheck } from "./broadcasts/full-health-check.js";

const DB_PATH = path.join(import.meta.dirname, "jobs.db");

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: new SqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleSubscriber()],
  maxConcurrent: 8,
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  adapter: new BroadcastSqliteAdapter({ dbPath: DB_PATH }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

broadcastRunner.register(fullHealthCheck);

console.log("Fleet monitor started.");
console.log("6 recurring health checks running at different intervals.");
console.log(\`Data persisted in \${DB_PATH}\`);
console.log("Open Station to watch real-time service health.\\n");

// Trigger a full health check broadcast every 60 seconds
setInterval(async () => {
  const id = await fullHealthCheck.trigger({
    label: \`scheduled-\${Date.now().toString(36)}\`,
  });
  console.log(\`\\n[broadcast] Triggered full health check: \${id}\\n\`);
}, 60_000);

// Also trigger one immediately after startup
setTimeout(async () => {
  const id = await fullHealthCheck.trigger({ label: "startup-check" });
  console.log(\`\\n[broadcast] Triggered startup health check: \${id}\\n\`);
}, 1000);

signalRunner.start();
broadcastRunner.start();`}</Code>

      <div className="info-box">
        <p>
          <code>onFailure("continue")</code> keeps checking remaining services even
          if one health check throws. Each check signal also runs independently on
          its own <code>.every()</code> interval. The broadcast adds a coordinated
          sweep that fans out all six checks in parallel and funnels results into a
          single aggregate report. Use <code>setInterval</code> to trigger the
          broadcast periodically.
        </p>
      </div>

      <p>
        <strong>Run it:</strong>{" "}
        <code>pnpm --filter example-fleet-monitor start</code>
      </p>
    </>
  );
}
