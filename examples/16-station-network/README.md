# Station Network example

This example runs one Headquarters and two execution stations against one
SQLite database. It demonstrates fleet discovery, atomic queue ownership,
per-station and fleet-wide concurrency, placement labels, runtime schedules,
shared environment variables, broadcasts, and a single-owner beacon.

SQLite is appropriate here because all three processes share a filesystem. Use
the matching PostgreSQL, MySQL, or Redis adapters when stations run on separate
machines.

## Run it

From this directory, open three terminals:

```bash
pnpm hq
```

```bash
STATION_ID=worker-ke-1 STATION_NAME="Kenya GPU" STATION_PORT=5610 STATION_GPU=true pnpm worker
```

```bash
STATION_ID=worker-ke-2 STATION_NAME="Kenya CPU" STATION_PORT=5620 STATION_GPU=false pnpm worker
```

Open `http://127.0.0.1:5600` and sign in with `admin` / `station`. Headquarters
accepts requests and reconciles schedules/broadcasts; the workers execute signal
runs and supervise beacons.

Before triggering `render-preview` or `release-pipeline`, create a global
`ASSET_BUCKET` value on the Environment page. The GPU-constrained render signal
can only run on `worker-ke-1`.

## Production changes

- Replace every SQLite adapter with the matching shared PostgreSQL, MySQL, or
  Redis adapter.
- Give every process a stable, unique `STATION_ID`.
- Store dashboard credentials and database URLs in a secret manager.
- Advertise only station endpoints that Headquarters can reach and protect
  those endpoints at the network boundary.
- Tune heartbeat and lease durations for real database/network jitter.
- Drain stations before deployment and wait for active work to finish.
