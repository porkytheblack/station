# 15 — Beacon (long-running primitive)

A **beacon** is a long-running, supervised process. Where a signal runs to
completion and exits, a beacon *stays up* — a server, a poller, or a client to
something. The `BeaconRunner` supervises each beacon in its own child process:
it keeps it alive per a restart policy, backs off between restarts, detects
heartbeat stalls, and shuts it down gracefully.

```bash
pnpm start
```

This starts four beacons from `beacons/`:

| Beacon | Mode | What it shows |
|---|---|---|
| `health-server` | `.run()` | An HTTP server on `:8099`. `restart("always")` keeps it up. |
| `uptime-poller` | `.poll("3s")` | Framework-managed interval loop; aborts in-flight work on stop. |
| `stream-client` | `.run()` | A flaky client that drops and reconnects with exponential backoff + heartbeat stall detection. |
| `queue-worker` | `.onDemand()` | One definition, many instances — each created at runtime with its own config. |

Press `Ctrl-C` to trigger a graceful shutdown — each beacon's `onStop` cleanup
runs before the process exits.

## Many instances of one beacon

`health-server`, `uptime-poller`, and `stream-client` are single processes: each
has one instance, seeded from its file and started on discovery.

`queue-worker` is different. It declares `.onDemand()`, so nothing starts on
discovery — instances are created at runtime, each with its own config. The
example creates two from code:

```ts
await runner.whenReady(); // start() only settles when the supervisor stops

await runner.createInstance("queue-worker", {
  id: "worker-billing",
  label: "billing queue",
  config: { queue: "billing", batchSize: 25 },
});
```

Both run as separate supervised processes, each with its own status, restart
counter, and logs. `.maxInstances(8)` caps how many can exist at once.

There are three ways a beacon comes to be running, and one definition can use
any of them:

| Start mode | Behaviour |
|---|---|
| `auto` (default) | One instance, seeded and started on discovery. |
| `.manualStart()` | One instance, seeded but stopped until someone starts it. |
| `.onDemand()` | No instance seeded — created via the API or `createInstance()`. |

## Dashboard

`station.config.ts` points the dashboard at these beacons. Run:

```bash
npx station
```

Then open **http://localhost:4400/beacons** to watch each beacon's status,
incarnation, restart count, live logs, and lifecycle events — and start / stop /
restart them from the UI. On a beacon's page, **New instance** builds one from
its config schema; each instance gets its own controls, logs, and a delete
button.

## Controlling instances over the API

The same operations are available over HTTP. On the dashboard API:

```bash
# Create an instance and start it
curl -X POST localhost:4400/api/beacons/queue-worker/instances \
     -H 'content-type: application/json' \
     -d '{"id":"worker-acme","label":"acme","config":{"queue":"acme","batchSize":25}}'

# List what is running
curl localhost:4400/api/beacons/queue-worker/instances

# Stop one, start it again, or remove it entirely
curl -X POST   localhost:4400/api/beacons/queue-worker/instances/worker-acme/stop
curl -X POST   localhost:4400/api/beacons/queue-worker/instances/worker-acme/start
curl -X DELETE localhost:4400/api/beacons/queue-worker/instances/worker-acme

# Stop every instance of a beacon at once
curl -X POST 'localhost:4400/api/beacons/queue-worker/stop?all=true'
```

The authenticated v1 API mirrors these under `/api/v1/beacons/...`, with
creating and starting on the `trigger` scope, stopping on `cancel`, and editing
or deleting an instance on `admin`.

Pass `"start": false` when creating to stage an instance without running it, and
`PATCH` an instance to change its config — add `"restart": true` to apply the
change to a running process immediately.

## Triggering signals from a beacon

Beacons can trigger signals (e.g. a poller firing an alert when a check fails).
Wire a `SignalRunner` into the `BeaconRunner` and use a **persistent** signal
adapter so the trigger — which happens in the beacon's child process — reaches
the same queue the `SignalRunner` drains:

```ts
import { SignalRunner } from "station-signal";
import { BeaconRunner } from "station-beacon";
import { SqliteAdapter } from "station-adapter-sqlite";

const signalRunner = new SignalRunner({
  signalsDir: "./signals",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
});

const beaconRunner = new BeaconRunner({
  beaconsDir: "./beacons",
  signalRunner, // beacons can now `signal.trigger()` into the shared queue
});

await signalRunner.start();
await beaconRunner.start();
```

Inside a beacon handler you then just call `myAlert.trigger({ ... })` like
anywhere else.
