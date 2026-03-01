# station-signal

A lightweight, type-safe background job framework for TypeScript. Define signals with Zod schemas, trigger them from anywhere, and let the runner execute each one in an isolated child process with timeout enforcement and automatic retries.

## Install

```bash
pnpm add station-signal
```

## Defining signals

Use the `signal()` builder to define a named signal with a Zod input schema and a handler function.

```ts
import { signal, z } from "station-signal";

export const sendEmail = signal("send-email")
  .input(z.object({ to: z.string().email(), subject: z.string(), body: z.string() }))
  .timeout(30_000)
  .retries(3)
  .run(async (input) => {
    await emailService.send(input.to, input.subject, input.body);
  });
```

The full builder chain is:

```ts
signal("name")
  .input(schema)       // Required. Zod schema that validates the input.
  .timeout(ms)         // Optional. Max execution time in milliseconds (default: 300000).
  .retries(n)          // Optional. Number of retries after the first failure (default: 0).
  .every("5m")         // Optional. Makes this a recurring signal on an interval.
  .run(fn)             // Required. The async handler function. Returns a Signal object.
```

| Method | Required | Description |
|---|---|---|
| `.input(schema)` | Yes | A Zod schema used to validate input at trigger time and before execution. |
| `.timeout(ms)` | No | Override the default 5-minute timeout, in milliseconds. |
| `.retries(n)` | No | Number of retries after the first attempt fails. Total attempts = `n + 1`. |
| `.every(interval)` | No | Schedule the signal to run on a recurring interval (e.g. `"every 5m"`). |
| `.run(fn)` | Yes | The async function that executes the signal. Finalizes and returns the `Signal` object. |

## Triggering signals

There are two ways to trigger a signal.

### Type-safe trigger

Call `.trigger()` directly on a signal object. The input is validated against the Zod schema before being enqueued.

```ts
import { sendEmail } from "./signals/send-email.js";

const entryId = await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Welcome",
  body: "Thanks for signing up.",
});
// entryId is a unique string identifying this queue entry
```

### Dynamic trigger

Use `SignalQueue` to trigger signals by name. This is useful when the signal name comes from a variable or external source. No schema validation is performed.

```ts
import { SignalQueue } from "station-signal";

const queue = new SignalQueue();
const entryId = await queue.trigger("send-email", {
  to: "alice@example.com",
  subject: "Welcome",
  body: "Thanks for signing up.",
});
```

Both approaches return a `Promise<string>` containing the queue entry ID.

## Running signals

`SignalRunner` polls the adapter for due entries and spawns an isolated child process for each one.

### Minimal example

```ts
import { SignalRunner } from "station-signal";

const runner = new SignalRunner({
  signalsDir: "./src/signals",
});

await runner.start();
```

### Full options

```ts
import { SignalRunner } from "station-signal";
import { SQLiteAdapter } from "station-adapter-sqlite";

const runner = new SignalRunner({
  // Auto-discover all .ts/.js files in this directory (recursive).
  signalsDir: "./src/signals",

  // Custom adapter for persistence. Defaults to MemoryAdapter.
  adapter: new SQLiteAdapter("jobs.db"),

  // How often to check for due entries, in milliseconds. Default: 1000.
  pollIntervalMs: 2000,

  // Default max attempts for signals that don't specify their own. Default: 1.
  maxAttempts: 3,

  // Path to a module that calls configure(). Imported by the runner on startup
  // AND by every spawned child process before the signal file.
  configModule: "/absolute/path/to/adapter.config.ts",
});

await runner.start();
```

### Manual registration

If you are not using `signalsDir`, you can register signals individually:

```ts
const runner = new SignalRunner();
runner.register("send-email", "/absolute/path/to/signals/send-email.ts");
runner.register("generate-report", "/absolute/path/to/signals/generate-report.ts");
await runner.start();
```

The `register()` method takes a signal name and the absolute file path to the module that exports the signal.

## Recurring signals

### Using the builder

Add `.every()` to any signal definition to make it recurring. The runner automatically schedules the first run on startup and reschedules after each execution.

```ts
export const healthCheck = signal("health-check")
  .input(z.object({}))
  .every("every 30s")
  .run(async () => {
    await pingAllServices();
  });
```

### Using SignalQueue

Schedule a recurring signal dynamically:

```ts
const queue = new SignalQueue();
await queue.schedule("cleanup-temp-files", "every 1h", {});
```

### Interval format

The interval string must match the format `"every <number><unit>"`.

| Unit | Meaning | Example |
|---|---|---|
| `s` | Seconds | `"every 30s"` |
| `m` | Minutes | `"every 5m"` |
| `h` | Hours | `"every 1h"` |
| `d` | Days | `"every 7d"` |

## Timeout and retries

Every signal has a timeout and a maximum number of attempts.

| Setting | Default | Builder method |
|---|---|---|
| Timeout | 300,000ms (5 minutes) | `.timeout(ms)` |
| Retries | 0 (1 total attempt) | `.retries(n)` |

When a signal times out or throws an error and has remaining retry attempts, the runner resets it to "pending" for another try.

**Trigger signals**: After exhausting all attempts, the entry is marked as `"failed"` with a `completedAt` timestamp.

**Recurring signals**: After exhausting all attempts for a given run, the entry resets its attempt counter to 0 and reschedules the next run based on its interval. Recurring signals never permanently fail.

## Adapters

Adapters control how queue entries are stored and retrieved.

### Setting the global adapter

```ts
import { configure } from "station-signal";
import { SQLiteAdapter } from "station-adapter-sqlite";

configure({ adapter: new SQLiteAdapter("jobs.db") });
```

The default adapter is `MemoryAdapter`, which stores entries in-process. It requires no configuration but does not persist data across restarts and cannot share state between the runner and its spawned child processes.

### The configModule pattern

Because `SignalRunner` spawns each signal in a separate child process, you need a way to ensure both the runner and every child process use the same adapter. The `configModule` option solves this:

```ts
// src/adapter.config.ts
import { configure } from "station-signal";
import { SQLiteAdapter } from "station-adapter-sqlite";

configure({ adapter: new SQLiteAdapter("jobs.db") });
```

```ts
// src/runner.ts
import { fileURLToPath } from "node:url";
import { SignalRunner } from "station-signal";

const runner = new SignalRunner({
  signalsDir: "./src/signals",
  configModule: fileURLToPath(new URL("./adapter.config.ts", import.meta.url)),
});

await runner.start();
```

The runner imports `configModule` on startup. Every spawned child process imports it before loading the signal file. This guarantees a consistent adapter everywhere.

## Writing a custom adapter

Implement the `SignalQueueAdapter` interface:

```ts
interface SignalQueueAdapter {
  add(entry: QueueEntry): Promise<void>;
  remove(id: string): Promise<void>;
  getDue(): Promise<QueueEntry[]>;
  getRunning(): Promise<QueueEntry[]>;
  update(id: string, patch: Partial<QueueEntry>): Promise<void>;
  ping(): Promise<boolean>;
  generateId(): string;
}
```

| Method | Contract |
|---|---|
| `add(entry)` | Store a new queue entry. |
| `remove(id)` | Delete an entry by its ID. |
| `getDue()` | Return all pending entries where `nextRunAt` is `null`/`undefined` or `<= now`. |
| `getRunning()` | Return all entries with status `"running"`. |
| `update(id, patch)` | Merge the partial patch into the existing entry. |
| `ping()` | Health check. Return `true` if the adapter is operational. |
| `generateId()` | Produce a unique string ID for a new queue entry. |

## How it works

1. `SignalRunner` polls the adapter at a configurable interval, calling `getDue()` to find entries that are ready to execute.
2. For each due entry, the runner marks it as `"running"` and spawns an isolated child process via `node --import tsx bootstrap.js`.
3. The child process first imports the `configModule` (if provided) to set up the shared adapter, then imports the signal file.
4. The bootstrap script finds the matching signal export, validates the input against the signal's Zod schema, and rejects with a `"failed"` status if validation fails.
5. The signal handler runs under timeout enforcement via `Promise.race`. If it completes in time, the entry is marked `"completed"`. If it throws, the entry is marked `"failed"`.
6. Back in the runner, `checkTimeouts()` runs each tick to detect entries that have been `"running"` longer than their configured timeout. Timed-out entries are either reset to `"pending"` for a retry or marked `"failed"` (trigger) / rescheduled (recurring) depending on remaining attempts.

## Types reference

### QueueEntry

```ts
interface QueueEntry {
  id: string;
  signalName: string;
  kind: QueueEntryKind;
  input: string;            // JSON-serialized
  status: EntryStatus;
  attempts: number;
  maxAttempts: number;
  timeout: number;          // milliseconds
  interval?: string;        // e.g. "every 5m" (recurring only)
  nextRunAt?: Date;
  lastRunAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}
```

### EntryStatus

```ts
type EntryStatus = "pending" | "running" | "completed" | "failed";
```

### QueueEntryKind

```ts
type QueueEntryKind = "trigger" | "recurring";
```

### Constants

```ts
const DEFAULT_TIMEOUT_MS = 300_000;   // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 1;       // no retry by default
```
