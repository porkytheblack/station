# 15 — Beacon (long-running primitive)

A **beacon** is a long-running, supervised process. Where a signal runs to
completion and exits, a beacon *stays up* — a server, a poller, or a client to
something. The `BeaconRunner` supervises each beacon in its own child process:
it keeps it alive per a restart policy, backs off between restarts, detects
heartbeat stalls, and shuts it down gracefully.

```bash
pnpm start
```

This starts three beacons from `beacons/`:

| Beacon | Mode | What it shows |
|---|---|---|
| `health-server` | `.run()` | An HTTP server on `:8099`. `restart("always")` keeps it up. |
| `uptime-poller` | `.poll("3s")` | Framework-managed interval loop; aborts in-flight work on stop. |
| `stream-client` | `.run()` | A flaky client that drops and reconnects with exponential backoff + heartbeat stall detection. |

Press `Ctrl-C` to trigger a graceful shutdown — each beacon's `onStop` cleanup
runs before the process exits.

## Dashboard

`station.config.ts` points the dashboard at these beacons. Run:

```bash
npx station
```

Then open **http://localhost:4400/beacons** to watch each beacon's status,
incarnation, restart count, live logs, and lifecycle events — and start / stop /
restart them from the UI.

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
