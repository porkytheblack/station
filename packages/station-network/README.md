# station-network

Shared control-plane contracts for a Station Network. A network contains one
logical **Headquarters** and any number of execution **stations**.

The package provides:

- station registration, heartbeats, labels, advertised definitions, capacity,
  draining, and offline detection;
- fenced controller leases used for fleet-wide signal concurrency and
  single-owner beacon instances;
- `StationNetworkMemoryAdapter` for tests and standalone processes.

Production adapters are exported from each database package:

```ts
import { StationNetworkPostgresAdapter } from "station-adapter-postgres/network";
// Also: station-adapter-mysql/network, station-adapter-redis/network,
// and station-adapter-sqlite/network.
```

Pass the same durable network adapter and job/beacon adapters to Headquarters
and every station. Share schedule storage across Headquarters replicas. The
memory adapter cannot coordinate separate processes.

```ts
import { defineConfig } from "station-kit";

export default defineConfig({
  role: "station",
  network: {
    id: "production",
    stationId: "worker-ke-1",
    name: "Kenya worker 1",
    adapter: networkAdapter,
    labels: { region: "ke", gpu: "false" },
    endpoint: "https://worker-ke-1.internal.example",
  },
  adapter: signalAdapter,
  beaconAdapter,
  signalsDir: "./signals",
  beaconsDir: "./beacons",
});
```

## Roles

- `headquarters` runs the API, dashboard, signal/schedule dispatch, and shared
  orchestration. Its signal runner has zero execution slots.
- `station` advertises definitions and executes signals and beacons. It does
  not reconcile schedules or broadcasts.
- `standalone` is the backwards-compatible single-node mode and performs both.

## Guarantees

Signal runs transition from pending to running through an atomic storage claim.
Every claim carries a station id, expiry, and fencing token. If a station dies,
the expired run is recovered; a stale station cannot complete the new owner's
attempt. Controller leases use the same fencing model for fleet concurrency and
beacons.

Schedule occurrences use an atomic claim in the schedule adapter, so multiple
Headquarters processes do not intentionally enqueue the same occurrence twice.
The planned time is when a run becomes eligible, not a hard real-time start
guarantee: polling, queue pressure, and available capacity can add delay.

## Backend selection

| Backend | Network adapter | Use case |
|---|---|---|
| Memory | `StationNetworkMemoryAdapter` | Unit tests and one process only |
| SQLite | `station-adapter-sqlite/network` | Multiple processes on one shared filesystem |
| PostgreSQL | `station-adapter-postgres/network` | Multi-machine production fleets |
| MySQL | `station-adapter-mysql/network` | Multi-machine production fleets; use async `.create()` |
| Redis | `station-adapter-redis/network` | Multi-machine production fleets |

Use a stable, unique `stationId` per process. Keep `network.id` identical across
the fleet. Set `endpoint` only to an HTTP(S) address Headquarters can actually
reach; exposed beacon proxying depends on it. Drain a station before maintenance
to stop new claims while active work completes.

## Production checks

Before rollout, exercise at least one Headquarters and two stations against the
chosen durable adapters. Verify atomic ownership, work distribution, placement
labels, per-station and fleet concurrency, schedule deduplication, expired-lease
recovery, and graceful shutdown. SQLite throughput on a laptop is not a sizing
proxy for PostgreSQL, MySQL, Redis, or a networked production workload.

## License

MIT
