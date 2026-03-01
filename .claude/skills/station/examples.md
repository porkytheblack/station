# Station Examples

Complete, copy-pasteable examples for the Station background job framework.

---

## 1. Basic Signal -- Send Email

A signal with typed input, timeout, retries, calling an external email API.

```ts
// signals/send-email.ts
import { signal, z } from "station-signal";

export const sendEmail = signal("send-email")
  .input(
    z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
    })
  )
  .timeout(15_000)
  .retries(2) // 3 total attempts (1 initial + 2 retries)
  .run(async (input) => {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: "noreply@myapp.com" },
        subject: input.subject,
        content: [{ type: "text/plain", value: input.body }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`SendGrid API error (${response.status}): ${error}`);
    }
  });
```

Trigger it:

```ts
// trigger.ts
import { sendEmail } from "./signals/send-email.js";

const runId = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Your order has shipped",
  body: "Tracking number: 1Z999AA10123456784",
});

console.log(`Queued email send: ${runId}`);
```

---

## 2. Signal with Output -- Image Processing

Signal that returns typed output using `.output()`.

```ts
// signals/resize-image.ts
import { signal, z } from "station-signal";

export const resizeImage = signal("resize-image")
  .input(
    z.object({
      sourceUrl: z.string().url(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      format: z.enum(["webp", "png", "jpeg"]),
    })
  )
  .output(
    z.object({
      outputUrl: z.string().url(),
      fileSizeBytes: z.number(),
      width: z.number(),
      height: z.number(),
    })
  )
  .timeout(30_000)
  .retries(1)
  .run(async (input) => {
    const response = await fetch("https://images.mycdn.com/api/resize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.IMAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: input.sourceUrl,
        width: input.width,
        height: input.height,
        format: input.format,
      }),
    });

    if (!response.ok) {
      throw new Error(`Image API error: ${response.status}`);
    }

    const result = await response.json();
    return {
      outputUrl: result.url as string,
      fileSizeBytes: result.size as number,
      width: input.width,
      height: input.height,
    };
  });
```

---

## 3. Multi-Step Signal -- Order Processing

Pipeline with `.step()` chain and `.build()`.

```ts
// signals/process-order.ts
import { signal, z } from "station-signal";

export const processOrder = signal("process-order")
  .input(
    z.object({
      orderId: z.string(),
      customerId: z.string(),
      items: z.array(z.object({
        sku: z.string(),
        quantity: z.number().int().positive(),
        pricePerUnit: z.number().positive(),
      })),
    })
  )
  .timeout(60_000)
  .retries(1)
  .step("validate", async (input) => {
    if (input.items.length === 0) {
      throw new Error("Order must contain at least one item");
    }
    const total = input.items.reduce(
      (sum, item) => sum + item.quantity * item.pricePerUnit,
      0
    );
    return { ...input, total };
  })
  .step("reserve-inventory", async (prev) => {
    const response = await fetch("https://api.warehouse.internal/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: prev.orderId,
        items: prev.items.map((i) => ({ sku: i.sku, qty: i.quantity })),
      }),
    });
    if (!response.ok) {
      throw new Error(`Inventory reservation failed: ${response.status}`);
    }
    const { reservationId } = (await response.json()) as { reservationId: string };
    return { ...prev, reservationId };
  })
  .step("charge-payment", async (prev) => {
    const response = await fetch("https://api.stripe.com/v1/charges", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        amount: String(Math.round(prev.total * 100)),
        currency: "usd",
        customer: prev.customerId,
        metadata: JSON.stringify({ orderId: prev.orderId }),
      }),
    });
    if (!response.ok) {
      throw new Error(`Payment failed: ${response.status}`);
    }
    const charge = (await response.json()) as { id: string };
    return { ...prev, chargeId: charge.id };
  })
  .step("send-confirmation", async (prev) => {
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: prev.customerId }] }],
        from: { email: "orders@myapp.com" },
        subject: `Order ${prev.orderId} confirmed`,
        content: [{
          type: "text/plain",
          value: `Your order for $${prev.total.toFixed(2)} has been confirmed. Charge ID: ${prev.chargeId}`,
        }],
      }),
    });
    return {
      orderId: prev.orderId,
      chargeId: prev.chargeId,
      reservationId: prev.reservationId,
      total: prev.total,
      status: "confirmed" as const,
    };
  })
  .build();
```

---

## 4. Recurring Signal -- Health Check

Signal with `.every()` and `.onComplete()` hook for alerting.

```ts
// signals/health-check.ts
import { signal, z } from "station-signal";

export const healthCheck = signal("health-check")
  .output(
    z.object({
      apiLatencyMs: z.number(),
      dbLatencyMs: z.number(),
      healthy: z.boolean(),
    })
  )
  .every("5m")
  .timeout(30_000)
  .run(async () => {
    const apiStart = Date.now();
    const apiRes = await fetch("https://api.myapp.com/health");
    const apiLatencyMs = Date.now() - apiStart;

    const dbStart = Date.now();
    const dbRes = await fetch("https://api.myapp.com/health/db");
    const dbLatencyMs = Date.now() - dbStart;

    const healthy = apiRes.ok && dbRes.ok;

    return { apiLatencyMs, dbLatencyMs, healthy };
  })
  .onComplete(async (output) => {
    if (!output.healthy) {
      await fetch(process.env.SLACK_WEBHOOK_URL!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `Health check FAILED -- API: ${output.apiLatencyMs}ms, DB: ${output.dbLatencyMs}ms`,
        }),
      });
    }
  });
```

---

## 5. Recurring Signal with Input

Using `.withInput()` to provide a default payload for recurring runs.

```ts
// signals/sync-inventory.ts
import { signal, z } from "station-signal";

export const syncInventory = signal("sync-inventory")
  .input(
    z.object({
      warehouseId: z.string(),
      region: z.enum(["us-east", "us-west", "eu-central"]),
    })
  )
  .every("6h")
  .withInput({ warehouseId: "WH-001", region: "us-east" })
  .timeout(120_000)
  .run(async (input) => {
    const response = await fetch(
      `https://api.warehouse.internal/sync/${input.warehouseId}?region=${input.region}`,
      { method: "POST" }
    );
    if (!response.ok) {
      throw new Error(`Inventory sync failed: ${response.status}`);
    }
    console.log(`Synced warehouse ${input.warehouseId} (${input.region})`);
  });
```

---

## 6. Broadcast -- CI Pipeline

Full DAG workflow. All signal files plus broadcast definition. Uses `.onFailure("fail-fast")`.

### Signal files

```ts
// signals/checkout.ts
import { signal, z } from "station-signal";

export const checkout = signal("checkout")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string() }))
  .output(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .timeout(30_000)
  .run(async (input) => {
    const response = await fetch("https://ci.internal/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`Checkout failed: ${response.status}`);
    const { workdir } = (await response.json()) as { workdir: string };
    return { ...input, workdir };
  });
```

```ts
// signals/lint.ts
import { signal, z } from "station-signal";

export const lint = signal("lint")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ passed: z.boolean(), errorCount: z.number() }))
  .timeout(60_000)
  .run(async (input) => {
    const response = await fetch("https://ci.internal/api/lint", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workdir: input.workdir }),
    });
    if (!response.ok) throw new Error(`Lint failed: ${response.status}`);
    return (await response.json()) as { passed: boolean; errorCount: number };
  });
```

```ts
// signals/test-unit.ts
import { signal, z } from "station-signal";

export const testUnit = signal("test-unit")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ passed: z.boolean(), testCount: z.number(), failedCount: z.number() }))
  .timeout(120_000)
  .retries(2)
  .run(async (input) => {
    const response = await fetch("https://ci.internal/api/test-unit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workdir: input.workdir }),
    });
    if (!response.ok) throw new Error(`Unit tests failed: ${response.status}`);
    return (await response.json()) as { passed: boolean; testCount: number; failedCount: number };
  });
```

```ts
// signals/build-app.ts
import { signal, z } from "station-signal";

export const buildApp = signal("build-app")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ artifactUrl: z.string(), buildTimeMs: z.number() }))
  .timeout(180_000)
  .run(async (input) => {
    const start = Date.now();
    const response = await fetch("https://ci.internal/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workdir: input.workdir }),
    });
    if (!response.ok) throw new Error(`Build failed: ${response.status}`);
    const { artifactUrl } = (await response.json()) as { artifactUrl: string };
    return { artifactUrl, buildTimeMs: Date.now() - start };
  });
```

```ts
// signals/deploy.ts
import { signal, z } from "station-signal";

export const deploy = signal("deploy")
  .input(z.object({ artifactUrl: z.string(), buildTimeMs: z.number() }))
  .output(z.object({ deploymentUrl: z.string(), environment: z.string() }))
  .timeout(120_000)
  .run(async (input) => {
    const response = await fetch("https://ci.internal/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ artifactUrl: input.artifactUrl }),
    });
    if (!response.ok) throw new Error(`Deploy failed: ${response.status}`);
    return (await response.json()) as { deploymentUrl: string; environment: string };
  });
```

### Broadcast definition

```ts
// broadcasts/ci-pipeline.ts
import { broadcast } from "station-broadcast";
import { checkout } from "../signals/checkout.js";
import { lint } from "../signals/lint.js";
import { testUnit } from "../signals/test-unit.js";
import { buildApp } from "../signals/build-app.js";
import { deploy } from "../signals/deploy.js";

// DAG:
//   checkout
//     |--> lint
//     |--> test-unit
//           |
//        build-app (waits for lint + test-unit)
//           |
//         deploy

export const ciPipeline = broadcast("ci-pipeline")
  .input(checkout)                     // root node: receives broadcast input
  .then(lint, testUnit)                // fan-out: both run in parallel after checkout
  .then(buildApp, {
    after: ["checkout", "lint", "test-unit"],
    map: (upstream) => upstream["checkout"], // pass checkout output as build input
  })
  .then(deploy)
  .onFailure("fail-fast")
  .timeout(300_000)
  .build();
```

### Trigger

```ts
// trigger.ts
import { ciPipeline } from "./broadcasts/ci-pipeline.js";

const runId = await ciPipeline.trigger({
  repo: "myorg/myapp",
  branch: "main",
  commitSha: "a1b2c3d4e5f6789012345678901234567890abcd",
});

console.log(`CI pipeline triggered: ${runId}`);
```

---

## 7. Broadcast with Conditional Nodes

Using `when` and `map` in `.then()` options.

```ts
// broadcasts/deploy-pipeline.ts
import { broadcast } from "station-broadcast";
import { buildApp } from "../signals/build-app.js";
import { runSmoke } from "../signals/run-smoke.js";
import { deployStaging } from "../signals/deploy-staging.js";
import { deployProd } from "../signals/deploy-prod.js";
import { notifyTeam } from "../signals/notify-team.js";

export const deployPipeline = broadcast("deploy-pipeline")
  .input(buildApp)
  .then(runSmoke)
  .then(deployStaging)
  .then(deployProd, {
    after: ["deploy-staging", "buildApp"],
    map: (upstream) => upstream["deploy-staging"],
    when: (upstream) => {
      // Only deploy to production if the original build was for the main branch
      const build = upstream["buildApp"] as { branch?: string } | undefined;
      return build?.branch === "main";
    },
  })
  .then(notifyTeam, {
    // Notify always runs -- uses staging output if prod was skipped
    after: ["deploy-prod", "deploy-staging"],
    map: (upstream) => upstream["deploy-prod"] ?? upstream["deploy-staging"],
  })
  .onFailure("skip-downstream")
  .build();
```

Key behavior:
- `when` receives upstream outputs keyed by node name. If it returns `false`, the node is skipped (status `"skipped"`, skipReason `"guard"`).
- Guard-skipped nodes do NOT propagate failure downstream. Downstream nodes see the skipped node and its output as `undefined`.
- `map` transforms the upstream outputs map into the signal's input.

---

## 8. ETL Pipeline

Recurring broadcast with `.every()`.

### Signal files

```ts
// signals/extract-users.ts
import { signal, z } from "station-signal";

export const extractUsers = signal("extract-users")
  .input(z.object({ since: z.string() }))
  .output(z.object({ users: z.array(z.object({ id: z.string(), email: z.string(), name: z.string() })), count: z.number() }))
  .timeout(60_000)
  .run(async (input) => {
    const response = await fetch(
      `https://api.source-system.internal/users?updated_since=${input.since}`,
      { headers: { Authorization: `Bearer ${process.env.SOURCE_API_KEY}` } }
    );
    if (!response.ok) throw new Error(`Extract failed: ${response.status}`);
    const users = (await response.json()) as Array<{ id: string; email: string; name: string }>;
    return { users, count: users.length };
  });
```

```ts
// signals/transform-users.ts
import { signal, z } from "station-signal";

export const transformUsers = signal("transform-users")
  .input(z.object({ users: z.array(z.object({ id: z.string(), email: z.string(), name: z.string() })), count: z.number() }))
  .output(z.object({ records: z.array(z.object({ externalId: z.string(), emailNormalized: z.string(), displayName: z.string() })), count: z.number() }))
  .timeout(30_000)
  .run(async (input) => {
    const records = input.users.map((u) => ({
      externalId: u.id,
      emailNormalized: u.email.toLowerCase().trim(),
      displayName: u.name,
    }));
    return { records, count: records.length };
  });
```

```ts
// signals/load-users.ts
import { signal, z } from "station-signal";

export const loadUsers = signal("load-users")
  .input(z.object({ records: z.array(z.object({ externalId: z.string(), emailNormalized: z.string(), displayName: z.string() })), count: z.number() }))
  .output(z.object({ inserted: z.number(), updated: z.number() }))
  .timeout(60_000)
  .retries(2)
  .run(async (input) => {
    const response = await fetch("https://api.data-warehouse.internal/bulk-upsert", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WAREHOUSE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: input.records }),
    });
    if (!response.ok) throw new Error(`Load failed: ${response.status}`);
    return (await response.json()) as { inserted: number; updated: number };
  });
```

### Broadcast definition

```ts
// broadcasts/etl-pipeline.ts
import { broadcast } from "station-broadcast";
import { extractUsers } from "../signals/extract-users.js";
import { transformUsers } from "../signals/transform-users.js";
import { loadUsers } from "../signals/load-users.js";

export const etlPipeline = broadcast("etl-pipeline")
  .input(extractUsers)
  .then(transformUsers)
  .then(loadUsers)
  .onFailure("fail-fast")
  .every("6h")
  .withInput({ since: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() })
  .build();
```

---

## 9. Complete Runner Setup

Full `runner.ts` with `SignalRunner` + `BroadcastRunner`, `SqliteAdapter`, graceful shutdown.

```ts
// runner.ts
import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

const DB_PATH = path.join(import.meta.dirname, "station.db");

// Both adapters share the same database file
const signalAdapter = new SqliteAdapter({ dbPath: DB_PATH });
const broadcastAdapter = new BroadcastSqliteAdapter({ dbPath: DB_PATH });

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: signalAdapter,
  subscribers: [new ConsoleSubscriber()],
  maxConcurrent: 10,
  retryBackoffMs: 2000,
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: path.join(import.meta.dirname, "broadcasts"),
  adapter: broadcastAdapter,
  subscribers: [new ConsoleBroadcastSubscriber()],
});

// Graceful shutdown: broadcast runner stops BEFORE signal runner
// because broadcast queries the DB during shutdown to cancel running nodes
async function shutdown() {
  console.log("Shutting down...");
  await broadcastRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await signalRunner.stop({ graceful: true, timeoutMs: 15_000 });
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start both runners (non-blocking -- they run polling loops)
signalRunner.start();
broadcastRunner.start();
```

---

## 10. Custom Subscriber -- Slack Alerts

Implementing `SignalSubscriber` with selective hooks.

```ts
// subscribers/slack-alert.ts
import type { SignalSubscriber } from "station-signal";

export class SlackAlertSubscriber implements SignalSubscriber {
  private webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  onRunFailed(event: { run: { id: string; signalName: string; attempts: number }; error?: string }): void {
    this.send(
      `:x: *Signal failed*: \`${event.run.signalName}\`\n` +
      `Run: \`${event.run.id}\`\n` +
      `Attempts: ${event.run.attempts}\n` +
      `Error: ${event.error ?? "Unknown"}`
    );
  }

  onRunTimeout(event: { run: { id: string; signalName: string; timeout: number } }): void {
    this.send(
      `:warning: *Signal timed out*: \`${event.run.signalName}\`\n` +
      `Run: \`${event.run.id}\`\n` +
      `Timeout: ${event.run.timeout}ms`
    );
  }

  onRunCompleted(event: { run: { id: string; signalName: string } }): void {
    this.send(
      `:white_check_mark: *Signal completed*: \`${event.run.signalName}\`\n` +
      `Run: \`${event.run.id}\``
    );
  }

  private send(text: string): void {
    fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch((err) => {
      console.error("Slack notification failed:", err);
    });
  }
}
```

Usage:

```ts
// runner.ts
import { SignalRunner } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";
import { SlackAlertSubscriber } from "./subscribers/slack-alert.js";

const runner = new SignalRunner({
  signalsDir: "./signals",
  adapter: new SqliteAdapter({ dbPath: "station.db" }),
  subscribers: [
    new SlackAlertSubscriber(process.env.SLACK_WEBHOOK_URL!),
  ],
});

await runner.start();
```

---

## 11. Remote Trigger Setup

Using `configure()` with `endpoint` and `apiKey` to trigger signals from a separate process.

```ts
// remote-trigger.ts
import { configure } from "station-signal";
import { sendEmail } from "./signals/send-email.js";

// Option A: explicit configure()
configure({
  endpoint: "https://station.myapp.com",
  apiKey: "sk_live_abc123def456",
});

// Option B: environment variables (auto-detected, no configure() needed)
// STATION_ENDPOINT=https://station.myapp.com
// STATION_API_KEY=sk_live_abc123def456

const runId = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Welcome aboard",
  body: "Your account is ready.",
});

console.log(`Triggered remotely: ${runId}`);
```

For broadcasts:

```ts
// remote-broadcast-trigger.ts
import { configure } from "station-signal";
import { ciPipeline } from "./broadcasts/ci-pipeline.js";

configure({
  endpoint: "https://station.myapp.com",
  apiKey: "sk_live_abc123def456",
});

const runId = await ciPipeline.trigger({
  repo: "myorg/myapp",
  branch: "main",
  commitSha: "a1b2c3d4e5f6789012345678901234567890abcd",
});

console.log(`CI pipeline triggered remotely: ${runId}`);
```

---

## 12. Shared Adapter for Separate Processes

When the trigger process and runner process share a SQLite database. The trigger writes directly to the same database instead of going through the HTTP API.

### Runner process

```ts
// runner.ts
import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const adapter = new SqliteAdapter({ dbPath: "/var/data/station.db" });

const runner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

await runner.start();
```

### Trigger process

```ts
// trigger.ts
import { configure } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";
import { sendEmail } from "./signals/send-email.js";

// Point to the same database file the runner uses
configure({
  adapter: new SqliteAdapter({ dbPath: "/var/data/station.db" }),
});

const runId = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Shipped",
  body: "Your order has shipped.",
});

console.log(`Run queued: ${runId}`);
process.exit(0);
```

---

## 13. Station Dashboard Configuration

Complete `station.config.ts` with all options.

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  host: "localhost",

  // Signal and broadcast directories (auto-discovered)
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",

  // Adapters (both share the same database file)
  adapter: new SqliteAdapter({ dbPath: "./station.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./station.db" }),

  // Signal runner tuning
  runner: {
    pollIntervalMs: 1000,
    maxConcurrent: 5,
    maxAttempts: 1,
    retryBackoffMs: 1000,
  },

  // Broadcast runner tuning
  broadcastRunner: {
    pollIntervalMs: 1000,
  },

  // Set to false to run the dashboard API without processing jobs
  runRunners: true,

  // Open browser on start
  open: true,

  // Log level: "debug" | "info" | "warn" | "error"
  logLevel: "info",

  // Dashboard authentication (required for API key management)
  auth: {
    username: "admin",
    password: "change-me-in-production",
  },
});
```

Run with:

```sh
npx station
```

---

## 14. PostgreSQL Setup

Using `PostgresAdapter` with a shared `pg.Pool`.

```ts
// runner.ts
import path from "node:path";
import pg from "pg";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { PostgresAdapter } from "station-adapter-postgres";
import { BroadcastPostgresAdapter } from "station-adapter-postgres/broadcast";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/station";

// Share a single connection pool across both adapters
const pool = new pg.Pool({ connectionString });

const signalAdapter = new PostgresAdapter({ pool });
const broadcastAdapter = new BroadcastPostgresAdapter({ pool });

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: signalAdapter,
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: path.join(import.meta.dirname, "broadcasts"),
  adapter: broadcastAdapter,
  subscribers: [new ConsoleBroadcastSubscriber()],
});

async function shutdown() {
  await broadcastRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await signalRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

signalRunner.start();
broadcastRunner.start();
```

Station config with PostgreSQL:

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import pg from "pg";
import { PostgresAdapter } from "station-adapter-postgres";
import { BroadcastPostgresAdapter } from "station-adapter-postgres/broadcast";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://localhost:5432/station",
});

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new PostgresAdapter({ pool }),
  broadcastAdapter: new BroadcastPostgresAdapter({ pool }),
  auth: {
    username: "admin",
    password: process.env.STATION_PASSWORD ?? "change-me",
  },
});
```

---

## 15. Redis Setup

Using `RedisAdapter` with a shared `ioredis` instance.

```ts
// runner.ts
import path from "node:path";
import Redis from "ioredis";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { RedisAdapter } from "station-adapter-redis";
import { BroadcastRedisAdapter } from "station-adapter-redis/broadcast";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

// Share a single Redis connection across both adapters
const redis = new Redis(redisUrl);

const signalAdapter = new RedisAdapter({ redis, prefix: "station" });
const broadcastAdapter = new BroadcastRedisAdapter({ redis, prefix: "station" });

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: signalAdapter,
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: path.join(import.meta.dirname, "broadcasts"),
  adapter: broadcastAdapter,
  subscribers: [new ConsoleBroadcastSubscriber()],
});

async function shutdown() {
  await broadcastRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await signalRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await redis.quit();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

signalRunner.start();
broadcastRunner.start();
```

Station config with Redis:

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import Redis from "ioredis";
import { RedisAdapter } from "station-adapter-redis";
import { BroadcastRedisAdapter } from "station-adapter-redis/broadcast";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new RedisAdapter({ redis }),
  broadcastAdapter: new BroadcastRedisAdapter({ redis }),
  auth: {
    username: "admin",
    password: process.env.STATION_PASSWORD ?? "change-me",
  },
});
```

---

## 16. MySQL Setup

Using `MysqlAdapter.create()` static factory. MySQL adapters are async -- use `await`.

```ts
// runner.ts
import path from "node:path";
import mysql from "mysql2/promise";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { MysqlAdapter } from "station-adapter-mysql";
import { BroadcastMysqlAdapter } from "station-adapter-mysql/broadcast";

const connectionString = process.env.DATABASE_URL ?? "mysql://root@localhost:3306/station";

// Share a single connection pool across both adapters
const pool = mysql.createPool(connectionString);

// MysqlAdapter uses a static factory (NOT new MysqlAdapter())
const signalAdapter = await MysqlAdapter.create({ pool });
const broadcastAdapter = await BroadcastMysqlAdapter.create({ pool });

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter: signalAdapter,
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: path.join(import.meta.dirname, "broadcasts"),
  adapter: broadcastAdapter,
  subscribers: [new ConsoleBroadcastSubscriber()],
});

async function shutdown() {
  await broadcastRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await signalRunner.stop({ graceful: true, timeoutMs: 15_000 });
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

signalRunner.start();
broadcastRunner.start();
```

Station config with MySQL:

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import mysql from "mysql2/promise";
import { MysqlAdapter } from "station-adapter-mysql";
import { BroadcastMysqlAdapter } from "station-adapter-mysql/broadcast";

const pool = mysql.createPool(
  process.env.DATABASE_URL ?? "mysql://root@localhost:3306/station"
);

const signalAdapter = await MysqlAdapter.create({ pool });
const broadcastAdapter = await BroadcastMysqlAdapter.create({ pool });

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: signalAdapter,
  broadcastAdapter,
  auth: {
    username: "admin",
    password: process.env.STATION_PASSWORD ?? "change-me",
  },
});
```

---

## 17. Project Structure

Recommended layout.

```
my-app/
  package.json
  tsconfig.json
  station.config.ts         # optional -- only needed for dashboard
  signals/
    send-email.ts
    resize-image.ts
    process-order.ts
    health-check.ts
  broadcasts/
    ci-pipeline.ts
    etl-pipeline.ts
  subscribers/
    slack-alert.ts
  runner.ts                  # entry point (or use `npx station`)
  trigger.ts                 # separate trigger script (optional)
```

### package.json

```json
{
  "name": "my-station-app",
  "type": "module",
  "scripts": {
    "start": "npx tsx runner.ts",
    "trigger": "npx tsx trigger.ts",
    "dashboard": "npx station"
  },
  "dependencies": {
    "station-signal": "^1.0.0",
    "station-broadcast": "^1.0.0",
    "station-adapter-sqlite": "^1.0.0",
    "station-kit": "^1.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## Quick Reference

| Concept | Syntax |
|---|---|
| Define a signal | `signal("name")` |
| Input schema | `.input(z.object({ ... }))` |
| Output schema | `.output(z.object({ ... }))` |
| Single handler | `.run(async (input) => { ... })` |
| Multi-step | `.step("name", fn).step("name", fn).build()` |
| Timeout | `.timeout(ms)` |
| Retries | `.retries(n)` (n retries = n+1 total attempts) |
| Concurrency limit | `.concurrency(n)` |
| Recurring | `.every("5m")` (units: `s`, `m`, `h`, `d`) |
| Recurring input | `.withInput({ ... })` |
| On complete hook | `.onComplete(async (output, input) => { ... })` |
| Trigger | `mySignal.trigger({ ... })` |
| Define a broadcast | `broadcast("name").input(rootSignal)` |
| Fan-out | `.then(sigA, sigB)` |
| With options | `.then(sig, { as, after, map, when })` |
| Failure policy | `.onFailure("fail-fast" \| "skip-downstream" \| "continue")` |
| Build broadcast | `.build()` |

### Import paths

```ts
import { signal, z, SignalRunner, ConsoleSubscriber, configure } from "station-signal";
import { broadcast, BroadcastRunner, ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { PostgresAdapter } from "station-adapter-postgres";
import { BroadcastPostgresAdapter } from "station-adapter-postgres/broadcast";
import { RedisAdapter } from "station-adapter-redis";
import { BroadcastRedisAdapter } from "station-adapter-redis/broadcast";
import { MysqlAdapter } from "station-adapter-mysql";
import { BroadcastMysqlAdapter } from "station-adapter-mysql/broadcast";
import { defineConfig } from "station-kit";
```

### Shutdown order

Always stop broadcast runner before signal runner:

```ts
await broadcastRunner.stop({ graceful: true, timeoutMs: 15_000 });
await signalRunner.stop({ graceful: true, timeoutMs: 15_000 });
```
