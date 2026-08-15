# station-adapter-postgres

PostgreSQL adapters for Station signal runs, broadcasts, schedules, environment
variables, beacons, and Station Network membership.

```bash
pnpm add station-adapter-postgres pg
```

```ts
import { PostgresAdapter } from "station-adapter-postgres";
import { StationNetworkPostgresAdapter } from "station-adapter-postgres/network";

const connectionString = process.env.DATABASE_URL!;
const signalAdapter = new PostgresAdapter({ connectionString });
const networkAdapter = new StationNetworkPostgresAdapter({ connectionString });
```

Specialized exports are available at `/broadcast`, `/schedules`, `/env`,
`/beacon`, and `/network`. Reuse a `pg.Pool` when several adapters share one
process. Schemas and indexes are created idempotently. PostgreSQL is the default
recommendation for multi-machine Station Networks.

## License

MIT
