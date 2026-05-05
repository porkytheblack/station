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
- "Create a dynamic broadcast" / "edit a broadcast at runtime" / "validate a broadcast spec" — runtime-editable broadcasts persisted via the v1 API. See **Dynamic broadcasts** below and `api-reference.md` §9, `examples.md` §20.
- "Schedule a signal", "schedule a broadcast", "edit a schedule", "preview next fire times" — runtime schedules, distinct from `.every()` in code. See **Schedules** below and `api-reference.md` §10, `examples.md` §21.
- "Write an expression", "validate this expression", "what does `input.foo` mean" — Station's expression language used inside dynamic broadcasts. See **Expressions** below and `api-reference.md` §11, `examples.md` §22.
- "Use Postgres / MySQL / Redis for API keys" or "configure custom API key storage" — pluggable `ApiKeyStorageAdapter`. See **KeyStore** below and `api-reference.md` §7.5.

## Critical Rules

1. **Always import `signal` and `z` from `station-signal`** - The `z` export is re-exported from Zod. Never install or import `zod` separately.
2. **Always use `.run()` for single-handler signals, `.step()` + `.build()` for multi-step signals** - Never mix these patterns. `.run()` returns a signal directly; `.step()` returns a `StepBuilder` that must be finalized with `.build()`.
3. **Always export signals and broadcasts from their files** - The runner uses auto-discovery via `import()` and scans `Object.values(mod)` for branded signal/broadcast objects.
4. **Use `.js` extension in import paths** - Even when importing `.ts` files. This is required for ESM resolution with Node.js.
5. **Never use `new MysqlAdapter()` or `new BroadcastMysqlAdapter()`** - These constructors are private. Always use the static `MysqlAdapter.create()` / `BroadcastMysqlAdapter.create()` factory methods (async).
6. **Broadcast adapters use subpath imports** - Import from `station-adapter-sqlite/broadcast`, `station-adapter-postgres/broadcast`, `station-adapter-mysql/broadcast`, or `station-adapter-redis/broadcast`.
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

## Subscriber Interfaces

Signal subscribers implement any subset of:
`onSignalDiscovered`, `onRunDispatched`, `onRunStarted`, `onRunCompleted`, `onRunTimeout`, `onRunRetry`, `onRunFailed`, `onRunCancelled`, `onRunSkipped`, `onRunRescheduled`, `onStepStarted`, `onStepCompleted`, `onStepFailed`, `onCompleteError`, `onLogOutput`

Broadcast subscribers implement any subset of:
`onBroadcastDiscovered`, `onBroadcastQueued`, `onBroadcastStarted`, `onBroadcastCompleted`, `onBroadcastFailed`, `onBroadcastCancelled`, `onNodeTriggered`, `onNodeCompleted`, `onNodeFailed`, `onNodeSkipped`

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
