# station-adapter-mysql

MySQL adapters for Station signal runs, broadcasts, schedules, environment
variables, beacons, and Station Network membership.

```bash
pnpm add station-adapter-mysql mysql2
```

```ts
import { MysqlAdapter } from "station-adapter-mysql";
import { StationNetworkMysqlAdapter } from "station-adapter-mysql/network";

const connectionString = process.env.DATABASE_URL!;
const signalAdapter = await MysqlAdapter.create({ connectionString });
const networkAdapter = await StationNetworkMysqlAdapter.create({ connectionString });
```

Specialized exports are available at `/broadcast`, `/schedules`, `/env`,
`/beacon`, and `/network`. Construction is asynchronous because tables and
indexes are prepared before the adapter becomes available. Reuse a `mysql2`
pool when several adapters share one process.

## License

MIT
