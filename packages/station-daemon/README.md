# station-daemon

The headless Station 3 runtime: signals, broadcasts, beacons, schedules, execution workers, network coordination, authentication and registry/API hosting. Its executable is `stationd`. It has no Next.js/React dependency and never starts the dashboard.

## Start

```sh
pnpm add station-daemon station-signal station-adapter-sqlite
```

```ts
// station.config.ts
import { defineConfig } from "station-daemon";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  adapter: new SqliteAdapter({ dbPath: "./station.db" }),
  signalsDir: "./signals",
  host: "127.0.0.1",
  port: 4400,
  auth: {
    username: "operator",
    password: process.env.STATION_AUTH_PASSWORD!,
  },
});
```

Set the password through your environment/secret mechanism, then run:

```sh
pnpm exec stationd --config ./station.config.ts
```

Port 4400 serves HTTP/event APIs. Install and run `station-dashboard` separately for the web interface:

```sh
pnpm add -D station-dashboard
STATION_DAEMON_URL=http://127.0.0.1:4400 PORT=4401 HOSTNAME=127.0.0.1 pnpm exec station-dashboard
```

Open port 4401 and authenticate with the daemon credentials. `station-runtime-cli` is another optional client; `station daemon start` can launch a detached local daemon after both packages are installed. Closing either client does not stop the daemon.

## Embed or join a network

`defineConfig` and configuration types are exported from `station-daemon`; `createStation(config, cwd)` is exported from `station-daemon/server`. The returned instance exposes `start()` and `stop()`. There is no third dashboard-port argument.

Roles are `standalone`, `headquarters` and `station`. Headquarters runs orchestration and accepts API requests; workers claim eligible queued work using shared adapters and membership leases. Configure shared durable signal/broadcast/beacon/membership adapters, stable identities, environment storage and private worker connectivity. A worker API URL is not a substitute for the shared queue. Memory defaults are useful locally and do not provide durable fleet recovery.

The daemon supports `registry: { rootDir, execution, upstream, activate }`:

- Registry storage uses immutable manifests and verified artifact blobs.
- Execution installs signals, broadcast planners and beacons under digest-qualified names.
- A worker upstream can synchronize compatible Headquarters images automatically.
- Registry APIs are operator-admin-only; customer image publication is not exposed.
- Trusted-local image execution requires explicit opt-in and is unsuitable for public uploaded code. The Docker backend requires a reviewed, digest-pinned Linux runtime image and real-engine validation before deployment.

See the repository guides [Station 3](../../docs/STATION-3.md) and [Station Images](../../docs/STATION-IMAGES.md) for complete configuration, publishing, protocol, environment and operational details.

## Breaking change from StationKit

StationKit is retired with no compatibility release. Replace imports with `station-daemon`, use `stationd` for the foreground runtime and launch clients separately. `open`, `--no-open` and the old dashboard proxy parameter are removed. Existing state is not deleted or implicitly downgraded; back up durable adapters before changing major versions. Published 2.x packages remain separate historical versions.
