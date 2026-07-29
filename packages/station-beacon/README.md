# station-beacon

The long-running, supervised process primitive for Station. Where a
[signal](../station-signal) runs to completion and exits, a **beacon** *stays
up* — an HTTP server, a queue consumer, a poller, a websocket client. The
`BeaconRunner` supervises each beacon in its own child process: it keeps it
alive according to a restart policy, backs off between restarts, detects
heartbeat stalls, and shuts it down gracefully.

## Install

```bash
pnpm add station-beacon station-signal
```

## Defining beacons

Use the `beacon()` builder. There are two terminals: `.run()` for a general
long-running handler, and `.poll()` for a framework-managed interval loop.

### Server

```ts
import { beacon, z } from "station-beacon";
import { createServer } from "node:http";

export const webhookServer = beacon("webhook-server")
  .config(z.object({ port: z.number().default(8080) }))
  .restart("always")
  .run(async (ctx) => {
    const server = createServer(handler).listen(ctx.config.port);
    ctx.ready();                       // mark healthy (optional)
    ctx.onStop(() => server.close());  // cleanup on stop
    await ctx.untilStopped();          // park until asked to stop
  });
```

### Poller

```ts
export const priceWatcher = beacon("price-watcher")
  .poll("30s", async (ctx) => {
    const price = await fetchPrice({ signal: ctx.signal });
    if (price > 100) await priceAlert.trigger({ price });  // trigger a signal
  });
```

### Client

```ts
export const streamConsumer = beacon("stream-consumer")
  .restart("on-failure")
  .backoff("1s", { max: "30s" })
  .heartbeat("10s")
  .run(async (ctx) => {
    const conn = await connect();
    ctx.ready();
    for await (const msg of conn.stream({ signal: ctx.signal })) {
      ctx.heartbeat();
      await ingest.trigger(msg);
    }
  });
```

## The builder

| Method | Description |
|---|---|
| `.config(schema)` | Zod schema for the beacon's config (validated before each start). |
| `.withConfig(data)` | Default config used when started without an override. |
| `.restart(policy)` | `"always"`, `"on-failure"` (default), or `"never"`. |
| `.backoff(base, opts?)` | Exponential restart backoff. `opts`: `{ factor, max, resetAfter }`. |
| `.heartbeat(interval, opts?)` | Opt into stall detection. Restarts if no `ctx.heartbeat()` within `opts.timeout` (default 3× interval). |
| `.startupTimeout(ms)` | Deadline from spawn to reach ready (`ctx.ready()`). If exceeded, the supervisor kills and restarts it (per policy). Off by default. |
| `.stopTimeout(ms)` | Grace period after a stop request before the process is force-killed (default `10s`). |
| `.manualStart()` | Seed one instance but leave it stopped until started explicitly. |
| `.onDemand()` | Seed nothing — instances are created at runtime, each with its own config. |
| `.maxInstances(n)` | Cap concurrent instances (default: the runner's `maxInstancesPerBeacon`, 100). |
| `.env(...keys)` | Require env var keys; a missing one marks the instance `errored` instead of spawning. |
| `.run(handler)` | Finalize with a long-running handler. |
| `.poll(interval, fn)` | Finalize as a poller — `fn` runs every `interval`. |

Intervals accept `"100ms"`, `"30s"`, `"5m"`, `"1h"`, `"1d"`, `"1w"`, or a raw
millisecond number.

## The context

Every handler receives a `ctx`:

| Field | Description |
|---|---|
| `ctx.config` | Validated config for this incarnation. |
| `ctx.name` | The beacon's name. |
| `ctx.instanceId` | Which instance this process is running. Equals `ctx.name` for a beacon's definition-owned instance. |
| `ctx.incarnation` | 1 on first start, incremented on each supervised restart. |
| `ctx.signal` | An `AbortSignal` that fires when the beacon should stop. Pass it to `fetch`, stream iterators, etc. |
| `ctx.ready()` | Mark the beacon ready/healthy (records `readyAt`). |
| `ctx.heartbeat()` | Report liveness (required if you declared `.heartbeat()`). |
| `ctx.log(msg)` | Emit a structured log line to subscribers. |
| `ctx.onStop(fn)` | Register cleanup to run when a stop is requested. |
| `ctx.untilStopped()` | Resolves when `ctx.signal` aborts — the idiomatic tail of a server handler. |

## Restart policies & backoff

- **`always`** — bring it back up on any exit (clean or crash). For servers and clients that should always be running.
- **`on-failure`** (default) — restart only on a crash/failure or a heartbeat stall; a clean return parks the beacon.
- **`never`** — run once; a clean return or a failure is terminal.

Restarts use exponential backoff: `base × factor^n`, capped at `max`. After a
beacon stays up longer than `resetAfter`, the counter resets so a later blip
restarts quickly instead of at the top of the curve.

## Liveness: startup timeout & heartbeats

The supervisor can kill and restart a process that is alive but unhealthy, in
two windows:

- **Startup timeout** (`.startupTimeout("30s")`) — the beacon must reach ready
  (`ctx.ready()`) within the deadline *from spawn*. This catches a boot/import
  that never resolves (the handler never even runs) and a handler that starts
  but wedges before coming up (e.g. a server that never binds its port). On a
  miss, the incarnation exits with reason `startup-timeout` and the restart
  policy takes over. Off by default; requires the beacon to call `ctx.ready()`.
- **Heartbeat stall** (`.heartbeat("10s")`) — once ready, the handler must call
  `ctx.heartbeat()` at least every interval; a gap longer than `opts.timeout`
  (default 3× the interval) is treated as a stall.

Startup timeout covers the *pre-ready* window and heartbeats cover the
*post-ready* window, so a beacon that declares both is supervised end to end.
Both `startup-timeout` and `stalled` exits restart under the `on-failure`
policy.

## Running the supervisor

```ts
import path from "node:path";
import { BeaconRunner, ConsoleBeaconSubscriber } from "station-beacon";

const runner = new BeaconRunner({
  beaconsDir: path.join(import.meta.dirname, "beacons"),
  subscribers: [new ConsoleBeaconSubscriber()],
});

await runner.start(); // discovers beacons and supervises them

// Graceful shutdown (SIGINT/SIGTERM are handled automatically too)
process.on("SIGINT", () => runner.stop({ graceful: true, timeoutMs: 10_000 }));
```

`start()` only settles once the supervisor stops. If you need the registry
populated first — to serve an API on top of the runner, or to create instances
at boot — await `runner.whenReady()`, which resolves after discovery, hydration
of persisted instances, and seeding.

### Runtime control

Flip a beacon's desired state at any time — the supervisor reconciles toward it:

```ts
await runner.stopBeacon("stream-consumer");     // stop and keep stopped
await runner.startBeacon("stream-consumer");    // start (optionally { config })
await runner.restartBeacon("stream-consumer");  // graceful stop, then relaunch

const instance = await runner.getInstance("stream-consumer");
// → { status, desiredState, incarnation, restartCount, readyAt, ... }
```

## Many instances of one beacon

A beacon definition can back many running **instances**, each supervised
independently with its own process, config, status, and logs — so the same
beacon can run once per tenant, queue, or stream.

Declare `.onDemand()` and nothing starts on discovery; instances exist only once
created:

```ts
export const queueWorker = beacon("queue-worker")
  .config(z.object({ queue: z.string(), batchSize: z.number().default(10) }))
  .onDemand()
  .maxInstances(8)
  .run(async (ctx) => {
    ctx.log(`worker ${ctx.instanceId} draining ${ctx.config.queue}`);
    ctx.ready();
    await ctx.untilStopped();
  });
```

```ts
runner.start().catch(console.error);
await runner.whenReady();

const worker = await runner.createInstance("queue-worker", {
  id: "worker-acme",                          // optional — generated when omitted
  label: "acme",
  config: { queue: "acme", batchSize: 25 },   // validated against the config schema
});                                           // starts immediately (start: false to stage it)

await runner.listInstances({ beaconName: "queue-worker" });
await runner.updateInstance(worker.id, { config: { queue: "acme2" }, restart: true });
await runner.stopInstance(worker.id);
await runner.deleteInstance(worker.id);       // stops the process, then removes the record
```

There are three start modes:

| Start mode | Behaviour |
|---|---|
| `auto` (default) | One instance, seeded and started on discovery. Its id is the beacon name. |
| `.manualStart()` | One instance, seeded but stopped until someone starts it. |
| `.onDemand()` | No instance seeded — created at runtime via the API or `createInstance()`. |

The instance seeded from the file has `origin: "definition"` and uses the beacon
name as its id, so `startBeacon` / `stopBeacon` / `restartBeacon` act on it and
pre-existing single-instance state carries over unchanged. Runtime-created
instances have `origin: "api"`, their own ids, and can be deleted.

With `station-kit`, all of this is available over HTTP under
`/api/beacons/:name/instances[/:instanceId]` (and `/api/v1/...` with scopes), and
on the dashboard.

## Triggering signals from a beacon

Wire a `SignalRunner` into the `BeaconRunner` and use a **persistent** signal
adapter, so a `signal.trigger()` from the beacon's child process reaches the
same queue the `SignalRunner` drains:

```ts
const beaconRunner = new BeaconRunner({ beaconsDir: "./beacons", signalRunner });
```

## Persistence

Supervision state (per-beacon status, desired state, restart counters, and an
optional event log) lives behind a `BeaconStateAdapter`. The default
`BeaconMemoryAdapter` is single-process; on restart the supervisor re-derives
desired state from each beacon's start mode, and runtime-created instances do
not survive. For durable state across restarts — and to keep instances created
through the API — use a `/beacon` subpath adapter:

```ts
import { BeaconSqliteAdapter } from "station-adapter-sqlite/beacon";
const adapter = new BeaconSqliteAdapter({ dbPath: "./station.db" });
new BeaconRunner({ beaconsDir: "./beacons", adapter });
```

`BeaconPostgresAdapter` (`/postgres/beacon`), `BeaconMysqlAdapter`
(`/mysql/beacon`, async `.create()`), and `BeaconRedisAdapter`
(`/redis/beacon`) are also available. Each migrates a database written before
multi-instance support in place on first open: the old per-beacon record becomes
that beacon's definition-owned instance, keeping its desired state and counters.

## Notes & limitations

- **Exit code 78 is reserved.** Fatal errors (invalid config, beacon not found)
  exit with `FATAL_EXIT_CODE` (78) so the supervisor parks them in `errored`
  without restart-looping. A handler that itself exits with 78 is treated as
  fatal.
- **Register before start.** `register()` after `start()` is not seeded or
  supervised (it warns). Use `beaconsDir` discovery or register up front.
- **Instance ids are global.** They are adapter primary keys and URL segments,
  so they must be unique across all beacons, match
  `/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/`, and be at most 128 characters. The bare
  beacon name is reserved for the definition-owned instance.
- **A definition-owned instance can't be deleted.** It is re-seeded from the
  beacon file on every boot; stop it instead. Only `origin: "api"` instances are
  removable.

## License

MIT
