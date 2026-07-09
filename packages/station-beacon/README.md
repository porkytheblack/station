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
| `.stopTimeout(ms)` | Grace period after a stop request before the process is force-killed (default `10s`). |
| `.manualStart()` | Don't auto-start on discovery — stays stopped until started explicitly. |
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

### Runtime control

Flip a beacon's desired state at any time — the supervisor reconciles toward it:

```ts
await runner.stopBeacon("stream-consumer");     // stop and keep stopped
await runner.startBeacon("stream-consumer");    // start (optionally { config })
await runner.restartBeacon("stream-consumer");  // graceful stop, then relaunch

const instance = await runner.getInstance("stream-consumer");
// → { status, desiredState, incarnation, restartCount, readyAt, ... }
```

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
desired state from each beacon's `autoStart` flag. Implement `BeaconStateAdapter`
against SQLite/Postgres/etc. for durable state across supervisor restarts.

## Notes & limitations

- **Exit code 78 is reserved.** Fatal errors (invalid config, beacon not found)
  exit with `FATAL_EXIT_CODE` (78) so the supervisor parks them in `errored`
  without restart-looping. A handler that itself exits with 78 is treated as
  fatal.
- **No startup timeout yet.** Heartbeat stall detection covers the *running*
  state; a beacon that hangs *before* reporting started (e.g. a module import
  that never resolves) stays in `starting`. Add a health/heartbeat once running,
  or supervise boot externally.
- **Register before start.** `register()` after `start()` is not seeded or
  supervised (it warns). Use `beaconsDir` discovery or register up front.

## License

MIT
