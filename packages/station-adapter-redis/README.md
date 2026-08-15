# station-adapter-redis

Redis adapters for Station signal runs, broadcasts, schedules, environment
variables, beacons, and Station Network membership.

```bash
pnpm add station-adapter-redis ioredis
```

```ts
import Redis from "ioredis";
import { RedisAdapter } from "station-adapter-redis";
import { StationNetworkRedisAdapter } from "station-adapter-redis/network";

const redis = new Redis(process.env.REDIS_URL!);
const signalAdapter = new RedisAdapter({ redis });
const networkAdapter = new StationNetworkRedisAdapter({ redis });
```

Specialized exports are available at `/broadcast`, `/schedules`, `/env`,
`/beacon`, and `/network`. Atomic Lua operations protect claims, fencing, and
controller leases across processes. Namespace separate environments with the
adapter prefix options.

## License

MIT
