---
name: station
description: Use this skill when building with the Station background job framework. This includes creating signals (background jobs), defining broadcasts (DAG workflows), authoring runtime-editable dynamic broadcasts, scheduling signals/broadcasts at runtime, writing expressions for `input` mappings and `when` guards, configuring adapters (SQLite, PostgreSQL, MySQL, Redis), customizing API key storage, setting up runners, writing subscribers, and configuring the Station dashboard. Station is a TypeScript-first framework for type-safe background jobs with Zod validation.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Station Task Expert

You are an expert Station developer specializing in building type-safe background job systems and DAG workflows.

## When to use this skill

Triggers include:

- Defining or triggering signals / file-defined broadcasts.
- "Run a server / poller / long-running client", "keep something alive", "supervise a process", "restart on crash", "daemon", "beacon" — the long-running primitive. See **Beacon Pattern** below and `examples/15-beacon`.
- "Create a dynamic broadcast" / "edit a broadcast at runtime" / "validate a broadcast spec" — runtime-editable broadcasts persisted via the v1 API. See **Dynamic broadcasts** below and `api-reference.md` §9, `examples.md` §20.
- "Schedule a signal", "schedule a broadcast", "edit a schedule", "preview next fire times" — runtime schedules, distinct from `.every()` in code. See **Schedules** below and `api-reference.md` §10, `examples.md` §21.
- "Write an expression", "validate this expression", "what does `input.foo` mean" — Station's expression language used inside dynamic broadcasts. See **Expressions** below and `api-reference.md` §11, `examples.md` §22.
- "Use Postgres / MySQL / Redis for API keys" or "configure custom API key storage" — pluggable `ApiKeyStorageAdapter`. See **KeyStore** below and `api-reference.md` §7.5.
- "Environment variables", "require an env var for a signal/beacon", "set env vars from the dashboard", "manage secrets", "Vercel-like environments", ".env()" — runtime-managed env vars injected into runs. See **Environment Variables (station-env)** below and `api-reference.md` §14, `examples.md` §25.

## Critical Rules

1. **Always import `signal` and `z` from `station-signal`** - The `z` export is re-exported from Zod. Never install or import `zod` separately.
2. **Always use `.run()` for single-handler signals, `.step()` + `.build()` for multi-step signals** - Never mix these patterns. `.run()` returns a signal directly; `.step()` returns a `StepBuilder` that must be finalized with `.build()`.
3. **Always export signals and broadcasts from their files** - The runner uses auto-discovery via `import()` and scans `Object.values(mod)` for branded signal/broadcast objects.
4. **Use `.js` extension in import paths** - Even when importing `.ts` files. This is required for ESM resolution with Node.js.
5. **Never use `new MysqlAdapter()` or `new BroadcastMysqlAdapter()`** - These constructors are private. Always use the static `MysqlAdapter.create()` / `BroadcastMysqlAdapter.create()` factory methods (async).
6. **Broadcast and beacon adapters use subpath imports** - Import broadcast adapters from `station-adapter-{sqlite,postgres,mysql,redis}/broadcast` and beacon adapters from `station-adapter-{sqlite,postgres,mysql,redis}/beacon`. The MySQL beacon adapter, like the others, is constructed via the async `BeaconMysqlAdapter.create()` factory (private constructor).
7. **Always shut down broadcast runner before signal runner** - Broadcast runner queries the signal adapter's database during shutdown. Stopping signal first closes the DB connection.
8. **`.retries(n)` sets retry count, not total attempts** - `.retries(2)` means 3 total attempts (1 initial + 2 retries). Internally stored as `maxAttempts = n + 1`.
11. **pnpm 10+ requires `onlyBuiltDependencies` for SQLite — only when you opt into it** - station-kit no longer pulls in `better-sqlite3` as a hard dependency (default key + log storage are pure-JS file backends). You only need `"pnpm": { "onlyBuiltDependencies": ["better-sqlite3"] }` in the consumer's `package.json` if you explicitly install `better-sqlite3` (e.g. to use `SqliteKeyStorage` or `station-adapter-sqlite`).
9. **`.trigger()` returns immediately with a run ID** - It does not wait for execution. Use `runner.waitForRun(id)` to block until completion.
10. **Zod v4 gotcha: never use `.default({})` on objects with default fields** - Use plain TypeScript defaults instead. Zod v4 internals: `schema._zod.def.type` (not `_def.typeName`).
12. **`station deploy` bundles to JS — shared imports are resolved automatically.** Signals/broadcasts can import from `../lib/`, `../shared/`, etc. These are bundled into shared chunks by esbuild. No need to configure includes for imported code — only use `deploy.include` for non-JS assets.
13. **Use `station-tauri` for desktop apps** — Do not use `station-kit` or `defineConfig` for Tauri/desktop integration. Use `createTauriStation()` from `station-tauri` instead. It runs localhost-only with no dashboard UI and auto-provisions API keys.
14. **Dynamic broadcasts and file-defined broadcasts live in separate registries** — names can collide harmlessly. The runner snapshots a dynamic spec into `BroadcastRun.definitionSnapshot` on trigger; spec edits never mutate in-flight runs. Versions are monotonic across delete + recreate (a recreated definition continues at the next version, not v1).
15. **Runtime schedules are additive** — `.every()` in signal/broadcast files keeps working. The `Schedule` adapter is a separate import path (`station-adapter-{sqlite,postgres,mysql,redis}/schedules`). Multi-runner deployments require an adapter that implements `claimDue` for at-most-once firing.
16. **Expressions are pure and JSON-serializable** — used by `DynamicNodeSpec.input` / `.when`. No I/O, no time, no randomness. If you can't express something, write a code-defined signal in TypeScript and reference it from the dynamic broadcast graph — the signal is the unit of arbitrary code, expressions just connect them.
17. **`KeyStore` methods are async** — `create`, `verify`, `list`, `revoke`, `close` all return Promises. Anyone calling them directly must `await`. The `new KeyStore("path/to/file")` string constructor still works but now constructs a `FileKeyStorage` (JSON file, no native deps). A `.db` extension is silently rewritten to `.json`; old SQLite-backed `station-keys.db` files are NOT auto-migrated — see the legacy-files startup warning emitted by `createStation`.

18. **`LogStore` is adapter-based** — `LogStorageAdapter` (`add`, `get`, optional `close`) wraps any backend. Default in `createStation` is `FileLogStorage` (append-only JSONL at `<dataDir>/station-logs.jsonl`, single-process only). Pass `logStorage` in `StationConfig` for Postgres / MySQL / Redis / S3 in production. `LogStore.get(runId)` returns `Promise<LogEntry[]>` — callers must await.

19. **Beacons are the long-running primitive — import `beacon`/`z` from `station-beacon`.** A beacon is a supervised process (server/poller/client), not a job: it isn't triggered, it's started/stopped/restarted by the `BeaconRunner`, which keeps it alive per a restart policy. Use `.run(handler)` for a general long-running handler or `.poll(interval, fn)` for an interval loop — never both. One beacon per file, exported for auto-discovery. Long-running `.run()` handlers should watch `ctx.signal` and end with `await ctx.untilStopped()` (or their own loop); returning early is treated as a clean completion. `station-beacon` has `station-signal` as a peer dependency.

## Signal Pattern

```ts
import { signal, z } from "station-signal";

export const sendEmail = signal("send-email")
  .input(z.object({
    to: z.string(),
    subject: z.string(),
    body: z.string(),
  }))
  .timeout(30_000)
  .retries(2)
  .run(async (input) => {
    await mailer.send(input);
  });
```

## Signal with Output

```ts
export const processImage = signal("process-image")
  .input(z.object({ url: z.string() }))
  .output(z.object({ thumbnailUrl: z.string(), width: z.number(), height: z.number() }))
  .run(async (input) => {
    const result = await sharp(input.url).resize(200).toBuffer();
    return { thumbnailUrl: uploadBuffer(result), width: 200, height: 200 };
  });
```

## Multi-Step Signal

```ts
export const processOrder = signal("process-order")
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
    await notify(`Order ${prev.orderId} charged: ${prev.chargeId}`);
  })
  .build();
```

## Recurring Signal

```ts
export const healthCheck = signal("health-check")
  .every("5m")
  .timeout(10_000)
  .retries(1)
  .run(async () => {
    const res = await fetch("https://api.example.com/health");
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  });
```

## Signal with onComplete Hook

```ts
export const ingestData = signal("ingest-data")
  .input(z.object({ source: z.string() }))
  .output(z.object({ rowCount: z.number() }))
  .run(async (input) => {
    const rows = await ingest(input.source);
    return { rowCount: rows.length };
  })
  .onComplete(async (output, input) => {
    await audit.log(`Ingested ${output.rowCount} rows from ${input.source}`);
  });
```

## Triggering Signals

```ts
// From application code
import { sendEmail } from "./signals/send-email.js";

const runId = await sendEmail.trigger({
  to: "user@example.com",
  subject: "Welcome",
  body: "Thanks for signing up.",
});

// Wait for completion (in tests or orchestration)
const run = await runner.waitForRun(runId, { timeoutMs: 30_000 });
```

## Broadcast Pattern (DAG Workflow)

```ts
import { broadcast } from "station-broadcast";
import { checkout } from "../signals/checkout.js";
import { lint } from "../signals/lint.js";
import { test } from "../signals/test.js";
import { build } from "../signals/build.js";
import { deploy } from "../signals/deploy.js";

export const ciPipeline = broadcast("ci-pipeline")
  .input(checkout)
  .then(lint, test)              // parallel after checkout
  .then(build)                   // waits for lint + test
  .then(deploy)                  // waits for build
  .onFailure("fail-fast")
  .timeout(300_000)
  .build();
```

## Broadcast with Node Options

```ts
export const pipeline = broadcast("etl-pipeline")
  .input(extract)
  .then(transform, {
    map: (upstream) => ({ records: upstream.extract }),
    when: (upstream) => upstream.extract != null,
  })
  .then(load, {
    after: ["transform"],
    map: (upstream) => upstream.transform,
  })
  .onFailure("skip-downstream")
  .build();
```

## Beacon Pattern (long-running primitive)

A **beacon** is a long-running, supervised process — a server, a poller, or a
client to something. Where a signal runs to completion and exits, a beacon stays
up. The `BeaconRunner` supervises each beacon in its own child process: restart
policy, exponential backoff, heartbeat stall detection, and graceful shutdown.
Import `beacon` and `z` from `station-beacon`.

Two terminals: `.run(handler)` for a general long-running handler, and
`.poll(interval, fn)` for a framework-managed interval loop.

```ts
import { beacon, z } from "station-beacon";
import { createServer } from "node:http";

// SERVER — stays alive until asked to stop
export const webhookServer = beacon("webhook-server")
  .config(z.object({ port: z.number().default(8080) }))
  .restart("always")
  .run(async (ctx) => {
    const server = createServer(handler).listen(ctx.config.port);
    ctx.ready();
    ctx.onStop(() => server.close());
    await ctx.untilStopped();
  });

// POLLER — fn runs every interval; can trigger signals
export const priceWatcher = beacon("price-watcher")
  .poll("30s", async (ctx) => {
    const price = await fetchPrice({ signal: ctx.signal });
    if (price > 100) await priceAlert.trigger({ price });
  });

// CLIENT — reconnects on failure with backoff + startup + heartbeat liveness
export const streamConsumer = beacon("stream-consumer")
  .restart("on-failure")
  .backoff("1s", { max: "30s" })
  .startupTimeout("30s")  // must connect (ctx.ready()) within 30s or get restarted
  .heartbeat("10s")       // ...and keep reporting liveness once connected
  .run(async (ctx) => {
    const conn = await connect();
    ctx.ready();
    for await (const msg of conn.stream({ signal: ctx.signal })) {
      ctx.heartbeat();
      await ingest.trigger(msg);
    }
  });
```

The handler `ctx`: `config`, `name`, `incarnation`, `signal` (AbortSignal that
fires on stop), `ready()`, `heartbeat()`, `log(msg)`, `onStop(fn)`,
`untilStopped()`.

### Beacon Runner Setup

```ts
import path from "node:path";
import { BeaconRunner, ConsoleBeaconSubscriber } from "station-beacon";

const beaconRunner = new BeaconRunner({
  beaconsDir: path.join(import.meta.dirname, "beacons"),
  subscribers: [new ConsoleBeaconSubscriber()],
  signalRunner, // optional: lets beacons trigger signals into the shared queue
});

await beaconRunner.start();

// Runtime control — the supervisor reconciles toward desired state
await beaconRunner.startBeacon("stream-consumer");   // or { config }
await beaconRunner.stopBeacon("stream-consumer");
await beaconRunner.restartBeacon("stream-consumer");
const instance = await beaconRunner.getInstance("stream-consumer");
```

## Runner Setup

```ts
import path from "node:path";
import { SignalRunner, ConsoleSubscriber } from "station-signal";
import { BroadcastRunner } from "station-broadcast";
import { ConsoleBroadcastSubscriber } from "station-broadcast";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

const adapter = new SqliteAdapter({ dbPath: "./jobs.db" });

const signalRunner = new SignalRunner({
  signalsDir: path.join(import.meta.dirname, "signals"),
  adapter,
  subscribers: [new ConsoleSubscriber()],
});

const broadcastRunner = new BroadcastRunner({
  signalRunner,
  broadcastsDir: path.join(import.meta.dirname, "broadcasts"),
  adapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
  subscribers: [new ConsoleBroadcastSubscriber()],
});

await signalRunner.start();
await broadcastRunner.start();

// Graceful shutdown (broadcast stops first)
process.on("SIGINT", async () => {
  await broadcastRunner.stop({ graceful: true, timeoutMs: 10_000 });
  await signalRunner.stop({ graceful: true, timeoutMs: 10_000 });
});
```

## Signal Adapter Reference

| Adapter | Package | Constructor |
|---------|---------|-------------|
| In-memory | (built-in) | `new MemoryAdapter()` |
| SQLite | `station-adapter-sqlite` | `new SqliteAdapter({ dbPath: "./jobs.db" })` |
| PostgreSQL | `station-adapter-postgres` | `new PostgresAdapter({ connectionString: "..." })` |
| MySQL | `station-adapter-mysql` | `await MysqlAdapter.create({ connectionString: "..." })` |
| Redis | `station-adapter-redis` | `new RedisAdapter({ url: "redis://localhost:6379" })` |

## Broadcast Adapter Reference

| Adapter | Import path | Constructor |
|---------|-------------|-------------|
| In-memory | (built-in) | `new BroadcastMemoryAdapter()` |
| SQLite | `station-adapter-sqlite/broadcast` | `new BroadcastSqliteAdapter({ dbPath: "./jobs.db" })` |
| PostgreSQL | `station-adapter-postgres/broadcast` | `new BroadcastPostgresAdapter({ connectionString: "..." })` |
| MySQL | `station-adapter-mysql/broadcast` | `await BroadcastMysqlAdapter.create({ connectionString: "..." })` |
| Redis | `station-adapter-redis/broadcast` | `new BroadcastRedisAdapter({ url: "redis://localhost:6379" })` |

## Beacon Adapter Reference

Durable `BeaconStateAdapter` implementations (instance state + lifecycle event log). Imported from the `/beacon` subpath. Pass to `defineConfig({ beaconAdapter })` or `new BeaconRunner({ adapter })`.

| Adapter | Import path | Constructor |
|---------|-------------|-------------|
| In-memory | `station-beacon` | `new BeaconMemoryAdapter()` |
| SQLite | `station-adapter-sqlite/beacon` | `new BeaconSqliteAdapter({ dbPath: "./jobs.db" })` |
| PostgreSQL | `station-adapter-postgres/beacon` | `new BeaconPostgresAdapter({ connectionString: "..." })` |
| MySQL | `station-adapter-mysql/beacon` | `await BeaconMysqlAdapter.create({ connectionString: "..." })` |
| Redis | `station-adapter-redis/beacon` | `new BeaconRedisAdapter({ url: "redis://localhost:6379" })` |

## Remote Triggers

```ts
import { configure } from "station-signal";

// Option 1: Explicit configuration
configure({
  endpoint: "https://station.example.com",
  apiKey: "sk_live_...",
});

// Option 2: Environment variables (auto-detected)
// STATION_ENDPOINT=https://station.example.com
// STATION_API_KEY=sk_live_...

// All .trigger() calls now go to the remote Station server
await sendEmail.trigger({ to: "user@example.com", subject: "Hello", body: "Hi" });
```

## Dashboard Setup (station-kit)

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  beaconsDir: "./beacons", // supervises beacons + surfaces them on the dashboard
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
  auth: { username: "admin", password: "changeme" },
});
```

Then run: `npx station`

Deploy: `npx station deploy` — generates a production bundle in `.station/out/`

## Deployment

### `station deploy`

Bundles signals, broadcasts, and config into a self-contained deploy directory using esbuild.

```sh
npx station deploy
```

**What it does:**
1. Discovers all `.ts`/`.js` files in `signalsDir` and `broadcastsDir`
2. Bundles each as an esbuild entry point with code splitting (shared imports become chunk files)
3. Externalizes npm packages (installed via `npm install` at deploy time)
4. Resolves `workspace:*` to `^{version}` for monorepo dependencies
5. Generates production `package.json`, `Dockerfile`, `nixpacks.toml`, `.dockerignore`, `.gitignore`
6. Copies `deploy.include` entries (non-JS assets)

**Output:** `.station/out/` — ready to deploy to any Docker-based platform.

### Environment variables

Set these in your deployment platform. They override config values at runtime.

| Variable | Overrides | Description |
|----------|-----------|-------------|
| `STATION_AUTH_USERNAME` | `auth.username` | Dashboard login username |
| `STATION_AUTH_PASSWORD` | `auth.password` | Dashboard login password |
| `PORT` | `port` | Server port |
| `HOST` | `host` | Server bind address |

If `auth` is not set in config but both `STATION_AUTH_USERNAME` and `STATION_AUTH_PASSWORD` are set, auth is enabled automatically.

### deploy.include

For non-JS assets that can't be discovered via imports:

```ts
export default defineConfig({
  deploy: {
    include: ["migrations/", "templates/email.html"],
  },
});
```

### Docker deployment

```sh
npx station deploy
docker build -t my-app .station/out
docker run -p 4400:4400 \
  -e STATION_AUTH_USERNAME=admin \
  -e STATION_AUTH_PASSWORD=secret \
  my-app
```

## Signal Builder Methods

| Method | Description |
|--------|-------------|
| `.input(schema)` | Zod schema for job payload |
| `.output(schema)` | Zod schema for return value |
| `.timeout(ms)` | Max execution time (default: 300000) |
| `.retries(n)` | Retry attempts after failure (default: 0) |
| `.concurrency(n)` | Max concurrent runs for this signal |
| `.every(interval)` | Recurring schedule: `"100ms"`, `"30s"`, `"5m"`, `"1h"`, `"1d"`, `"1w"` |
| `.withInput(data)` | Default input for recurring signals |
| `.env(...keys)` | Require env var keys — a run won't dispatch unless each is present in the env store or the host env |
| `.run(handler)` | Single handler function (returns signal) |
| `.step(name, fn)` | Add pipeline step (returns StepBuilder) |
| `.build()` | Finalize multi-step signal (on StepBuilder) |
| `.onComplete(fn)` | Post-completion hook (on signal or StepBuilder) |

## Broadcast Builder Methods

| Method | Description |
|--------|-------------|
| `.input(signal)` | Root signal (entry point of the DAG) |
| `.then(...signals)` | Add parallel tier (all run after previous tier) |
| `.then(signal, { as, after, map, when })` | Add signal with routing options |
| `.onFailure(policy)` | `"fail-fast"`, `"skip-downstream"`, `"continue"` |
| `.timeout(ms)` | Broadcast-level timeout |
| `.every(interval)` | Recurring broadcast schedule |
| `.withInput(data)` | Default recurring input |
| `.build()` | Finalize broadcast definition |

## Beacon Builder Methods

| Method | Description |
|--------|-------------|
| `.config(schema)` | Zod schema for config (validated before each start) |
| `.withConfig(data)` | Default config when started without an override |
| `.restart(policy)` | `"always"`, `"on-failure"` (default), `"never"` |
| `.backoff(base, opts?)` | Exponential restart backoff; `opts`: `{ factor, max, resetAfter }` |
| `.heartbeat(interval, opts?)` | Stall detection — restart if no `ctx.heartbeat()` within `opts.timeout` (default 3× interval) |
| `.startupTimeout(ms)` | Deadline from spawn to reach ready (`ctx.ready()`) — restart if it never comes up. Off by default |
| `.stopTimeout(ms)` | Grace period before force-kill on stop (default `10s`) |
| `.env(...keys)` | Require env var keys — the supervisor marks the beacon `errored` instead of spawning if any is missing |
| `.manualStart()` | Don't auto-start on discovery |
| `.run(handler)` | Finalize with a long-running handler |
| `.poll(interval, fn)` | Finalize as a poller — `fn` runs every `interval` |

Beacon runner controls: `startBeacon(name, { config? })`, `stopBeacon(name)`, `restartBeacon(name)`, `getInstance(name)`, `listInstances()`, `register(beacon, filePath)`.

## Subscriber Interfaces

Signal subscribers implement any subset of:
`onSignalDiscovered`, `onRunDispatched`, `onRunStarted`, `onRunCompleted`, `onRunTimeout`, `onRunRetry`, `onRunFailed`, `onRunCancelled`, `onRunSkipped`, `onRunRescheduled`, `onStepStarted`, `onStepCompleted`, `onStepFailed`, `onCompleteError`, `onLogOutput`

Broadcast subscribers implement any subset of:
`onBroadcastDiscovered`, `onBroadcastQueued`, `onBroadcastStarted`, `onBroadcastCompleted`, `onBroadcastFailed`, `onBroadcastCancelled`, `onNodeTriggered`, `onNodeCompleted`, `onNodeFailed`, `onNodeSkipped`

Beacon subscribers implement any subset of:
`onBeaconDiscovered`, `onBeaconStarting`, `onBeaconStarted`, `onBeaconReady`, `onBeaconHeartbeat`, `onBeaconExited`, `onBeaconRestartScheduled`, `onBeaconStopped`, `onBeaconErrored`, `onBeaconStalled`, `onBeaconLog`

## Dynamic Broadcasts

Runtime-editable broadcasts. The DAG is JSON (a `DynamicBroadcastSpec`) persisted via the broadcast adapter and reconciled into the runner's live registry.

```ts
// A spec is a plain JSON object. Persist it via POST /api/v1/broadcast-definitions.
const spec = {
  name: "high-value-order",
  failurePolicy: "skip-downstream",
  nodes: [
    { name: "score", signalName: "score-order", dependsOn: [] },
    {
      name: "notify",
      signalName: "notify-vip",
      dependsOn: ["score"],
      when: { kind: "op", op: ">", args: [
        { kind: "ref", path: ["score", "score"] },
        { kind: "lit", value: 0.8 },
      ]},
      input: { kind: "obj", entries: {
        orderId: { kind: "ref", path: ["input", "orderId"] },
      }},
    },
  ],
};
```

- `DynamicNodeSpec.input` / `.when` are `ExprNode`s — see the Expressions section below.
- File-defined and dynamic broadcasts live in **separate registries**; names may collide.
- `triggerDynamic` snapshots the spec into `BroadcastRun.definitionSnapshot`. Edits to the spec do not affect in-flight runs.
- Save bumps `version` monotonically. Delete is soft. Recreating a deleted name continues at the next version (not v1).
- v1 endpoints (`api-reference.md` §9): create / validate / list / get / version-history / get-by-version / delete / `trigger-dynamic-broadcast`.

## Schedules (station-schedules)

Runtime-editable schedules — distinct from `.every()` in signal/broadcast files. Three kinds: `signal`, `broadcast-static`, `broadcast-dynamic`.

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import { ScheduleSqliteAdapter } from "station-adapter-sqlite/schedules";

export default defineConfig({
  // ... adapter / broadcastAdapter ...
  scheduleAdapter: new ScheduleSqliteAdapter({ dbPath: "./station.db" }),
});
```

When `scheduleAdapter` is set, station-kit wires a `ScheduleReconciler` into both runners automatically. For hand-rolled runners, pass `scheduleReconciler` to `SignalRunner` / `BroadcastRunner` constructor options.

`interval` grammar (handled by `parseInterval` from `station-signal`): `"100ms"`, `"30s"`, `"5m"`, `"1h"`, `"1d"`, `"1w"`.

Multi-runner deployments require an adapter implementing `claimDue` for at-most-once firing. The in-memory adapter is single-process only.

v1 endpoints: `POST /api/v1/schedules`, `GET /api/v1/schedules`, `GET /api/v1/schedules/:id`, `PATCH /api/v1/schedules/:id`, `DELETE /api/v1/schedules/:id`, `POST /api/v1/schedules/:id/preview` (next N fire times). See `api-reference.md` §10 and `examples.md` §21.

## Expressions (station-expressions)

Pure, deterministic expression language for `DynamicNodeSpec.input` and `.when`. JSON-serializable AST plus an optional string syntax (`parse` / `stringify`).

```ts
import { evaluate, validate, parse, stringify } from "station-expressions";

// Author from string, persist as AST.
const node = parse(`input.amount > 100 && upstream.score.value >= 0.8`);

evaluate(node, { input: { amount: 250 }, upstream: { score: { value: 0.9 } } });
// → true
```

- `ExprNode` kinds: `ref`, `lit`, `tmpl`, `op`, `obj`, `arr`.
- Reference paths: `input.foo` (broadcast trigger input), `upstream.nodeName.field` (upstream node output), `nodeName.field` (shorthand).
- Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`, `+`, `-`, `*`, `/`. `+` is overloaded to string-concat if either operand is a string.
- v1 endpoints (read scope): `POST /api/v1/expressions/{parse,evaluate,validate}`.
- **Escape hatch**: when the language can't express something, write a code-defined signal in TypeScript and reference it from the broadcast graph. The signal is the unit of arbitrary code; expressions just connect them.

## API Key Storage (pluggable)

API keys live behind `ApiKeyStorageAdapter`. Default is `FileKeyStorage` — a JSON file at `<dataDir>/station-keys.json` written via fsync'd tmp + rename, with `0o600`/`0o700` perms. No native dependencies. Other built-ins: `MemoryKeyStorage` (tests), `SqliteKeyStorage` (opt-in; lazy-loads the optional `better-sqlite3` package, helpful error if missing). Pass a custom adapter via `auth.keyStorage` for Postgres / MySQL / Redis / etc.

```ts
import { defineConfig } from "station-kit";

export default defineConfig({
  auth: {
    username: "admin",
    password: "secret",
    keyStorage: new MyPostgresKeyStorage(pool), // implements ApiKeyStorageAdapter
  },
});
```

The `ApiKeyStorageAdapter` interface is `{ insert, findByHash, list, touch, revoke, close? }`. Methods may be sync or async — `KeyStore` awaits them either way. All `KeyStore` methods (`create`, `verify`, `list`, `revoke`, `close`) are async; callers must `await`. The `new KeyStore("path/to/keys.json")` string overload constructs a `FileKeyStorage`; a `.db` path is silently rewritten to `.json` for backwards compatibility, but old SQLite-backed `station-keys.db` files are NOT auto-migrated (a startup warning is emitted if one is detected). See `api-reference.md` §7.5 for the interface and `examples.md` §23 for a custom adapter skeleton.

## Environment Variables (station-env)

Runtime-managed env vars — define them once (globally or scoped to specific signals/beacons) instead of exporting everything into the Station process, require presence for a run, and edit values from the dashboard while Station is running (Vercel-like environments). Vars are injected into each run's `process.env` over the private IPC channel (never the spawn env), so secrets don't leak via `/proc/<pid>/environ`.

Import `signal`/`z` from `station-signal` as usual; the only builder addition is `.env()`.

```ts
import { signal, z } from "station-signal";

export const charge = signal("charge")
  .input(z.object({ amount: z.number() }))
  .env("STRIPE_API_KEY")          // required — run fails fast if absent
  .run(async (input) => {
    await stripe(process.env.STRIPE_API_KEY!).charge(input.amount);
  });
```

- **Requiring a var**: `.env("KEY", ...)` on a signal or beacon. Before dispatch the runner checks each key against the env store **and** the host `process.env`; a signal run **fails** with a clear error listing the missing keys, a beacon is marked **errored** (terminal — no restart loop; `startBeacon` clears it so you can retry after defining the var). Reserved keys (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `STATION_*`, …) are rejected — they change how the child executes, not what the handler reads.
- **Scoping (resolution model)**: a var with no targets is **global** (injected into every signal and beacon); a var with `targets` applies only to those and **overrides** a global var of the same key. Two vars may share a key only if their scopes can't both apply to one target (resolution stays deterministic) — the store rejects a conflicting definition.
- **Secrets**: mark a var `secret` and its value becomes write-only — the API/dashboard return `value: null`, but the real value is still injected at run time. A secret can't be downgraded to non-secret.
- **Storage (pluggable)**: default is `FileEnvStorage` — a JSON file at `<dataDir>/station-env.json` (fsync'd tmp + rename, `0o600`, no native deps, single-process). Pass `envStorage` in `StationConfig` for a durable adapter from a `station-adapter-{sqlite,postgres,mysql,redis}/env` subpath in multi-process deployments. `EnvStore` methods (`create`, `update`, `delete`, `resolveFor`, `listPublic`, `close`) are async.
- **Dashboard**: the **Environment** page defines vars, marks them secret, sets scope (global or specific targets), and flags any required-but-undefined vars. Hand-rolled runners: pass `envProvider` (an `EnvStore`) to `SignalRunner` / `BeaconRunner`.
- **v1 API**: `GET /api/v1/env` (read scope, secrets redacted), `POST /api/v1/env`, `PATCH /api/v1/env/:id`, `DELETE /api/v1/env/:id` (admin scope). See `api-reference.md` §14.

```ts
// station.config.ts — durable env storage for production
import { defineConfig } from "station-kit";
import { EnvPostgresAdapter } from "station-adapter-postgres/env";

export default defineConfig({
  envStorage: new EnvPostgresAdapter({ connectionString: process.env.DATABASE_URL }),
});
```

## Run Log Storage (pluggable)

Run logs live behind `LogStorageAdapter` (`add`, `get`, optional `close`). Default in `createStation` is `FileLogStorage` — append-only JSONL at `<dataDir>/station-logs.jsonl` with an `onError` hook wired to `console.error`. The default is **single-process only**; running two `createStation` instances against the same data dir will interleave bytes once individual log lines exceed 4 KB. `LogStore.get(runId)` is async (returns `Promise<LogEntry[]>`).

For multi-process / multi-replica / distributed deployments, implement `LogStorageAdapter` against a real backend and pass it via `logStorage`:

```ts
import { defineConfig, type LogStorageAdapter, type LogEntry } from "station-kit";

class PostgresLogStorage implements LogStorageAdapter {
  async add(entry: LogEntry) { /* INSERT INTO logs ... */ }
  async get(runId: string) { /* SELECT ... ORDER BY id */ return []; }
}

export default defineConfig({
  logStorage: new PostgresLogStorage(/* pool */),
});
```

Built-ins: `FileLogStorage` (default), `MemoryLogStorage` (tests). The legacy SQLite-backed log store has been removed; an old `station-logs.db` triggers the same startup warning as `station-keys.db`.

## Tauri Sidecar (station-tauri)

For running Station as a desktop app sidecar via Tauri v2.

```ts
import { createTauriStation } from "station-tauri";

const station = await createTauriStation({
  dataDir: "/path/to/app/data",
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  port: 4400,
});

// station.port — bound port
// station.apiKey — auto-provisioned API key
// station.keyStore — key store instance
// station.dataDir — resolved data directory
await station.stop();
```

Standalone sidecar entry point (`station-sidecar` bin) outputs JSON to stdout on startup:

```json
{"event":"ready","port":4400,"apiKey":"sk_live_..."}
```

Environment variables for the sidecar:

| Variable | Required | Description |
|----------|----------|-------------|
| `STATION_DATA_DIR` | Yes | Data directory for DB and key file |
| `STATION_PORT` | No | Server port (default: 4400) |
| `STATION_SIGNALS_DIR` | No | Signals directory |
| `STATION_BROADCASTS_DIR` | No | Broadcasts directory |

## Design Principles

1. One signal per file -- auto-discovery expects exported signal objects from each file in `signalsDir`.
2. Use Zod schemas for all inputs -- validation runs before execution and before remote dispatch.
3. Keep handlers focused -- extract shared logic into utility functions, not signal handlers.
4. Use steps for pipelines where each stage transforms data and passes it forward.
5. Use broadcasts for fan-out/fan-in workflows composed of independent signals.
6. Configure retries for anything that touches external services or networks.
7. Use subscribers for cross-cutting concerns: logging, metrics, alerting, webhooks.
8. Shut down broadcast runner before signal runner -- broadcast queries the signal DB during teardown.
9. Signal names must start with a letter and contain only letters, digits, hyphens, and underscores.
10. The runner registry is private (`this.registry: Map`). Access via `(runner as any).registry` for testing only.

## Reference Documentation

- `api-reference.md` - Complete API for all packages: types, interfaces, runner options. Sections 9-11 cover dynamic broadcasts, schedules, and expressions; §7.5 covers the `ApiKeyStorageAdapter` interface.
- `examples.md` - Full working examples: ETL pipelines, CI workflows, monitoring, e-commerce, Tauri desktop. Sections 20-23 cover dynamic broadcasts, schedules, expressions, and custom API key storage.
