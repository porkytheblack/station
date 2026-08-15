# station-kit

The Station API, dashboard, runners, and Station Network control plane.

## Install

```bash
pnpm add station-kit station-signal
```

Add a durable adapter for production. SQLite is the simplest local start:

```bash
pnpm add station-adapter-sqlite
```

## Standalone quick start

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  adapter: new SqliteAdapter({ dbPath: "./station.db" }),
  signalsDir: "./signals",
  auth: {
    username: "admin",
    password: process.env.STATION_PASSWORD!,
  },
});
```

```bash
STATION_PASSWORD=change-me npx station
```

Open `http://localhost:4400`. The configured Station address serves both the
dashboard and `/api/v1`.

## Scale into a Station Network

A network has one logical **Headquarters** and multiple execution **stations**.
Headquarters accepts API requests, reconciles schedules and broadcasts, and
shows fleet state. Stations advertise definitions and capacity, then atomically
claim eligible signal runs and beacon instances from shared adapters.

```ts
export default defineConfig({
  role: "station", // "headquarters" | "station" | "standalone"
  adapter: signalAdapter,
  network: {
    id: "production",
    stationId: process.env.STATION_ID!,
    adapter: networkAdapter,
    labels: { region: "ke", gpu: "true" },
  },
  signalsDir: "./signals",
  runner: { maxConcurrent: 12 },
});
```

Every process in a fleet must use the same durable queue and network backends.
Use `station-adapter-postgres`, `station-adapter-mysql`, or
`station-adapter-redis` across machines. SQLite is only appropriate when all
processes share one filesystem.

## Configuration highlights

- `role` selects standalone, Headquarters, or execution-station behavior.
- `network` configures identity, membership storage, labels, endpoint, and
  heartbeat/lease timing.
- `adapter`, `broadcastAdapter`, `beaconAdapter`, `scheduleAdapter`, and
  `envStorage` hold durable runtime state.
- `signalsDir`, `broadcastsDir`, and `beaconsDir` discover definitions.
- `runner.maxConcurrent` bounds total signal work on this process.
- `runRunners` defaults to `false` for Headquarters and `true` otherwise.
- `auth` protects browser sessions and enables scoped API keys.

## Production notes

- Give every process a stable, unique `network.stationId`.
- Use authentication and TLS anywhere beyond localhost.
- Drain a station before deployment so it stops taking new work.
- Keep lease durations above normal database, network, and event-loop jitter.
- Exercise two workers against the real backend before rollout: verify single
  ownership, placement, local/fleet concurrency, schedule deduplication, and
  expired-lease recovery.

See the repository documentation for the complete dashboard, v1 API, Station
Network, adapter, schedule, environment, and beacon guides.

## License

MIT
