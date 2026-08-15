# station-broadcast

Durable DAG workflows for `station-signal`.

```bash
pnpm add station-broadcast station-signal
```

```ts
import { broadcast } from "station-broadcast";

export const release = broadcast("release")
  .node("build", { signal: "build" })
  .node("deploy", { signal: "deploy", dependsOn: ["build"] })
  .failurePolicy("fail-fast")
  .timeout("10m")
  .build();
```

Broadcast nodes fan out when dependencies allow and fan in when all upstream
nodes complete. The durable runner records workflow and node state, supports
`fail-fast` or `continue` failure behavior, and uses Station signals for actual
execution. Dynamic broadcast definitions add validated, versioned DAGs through
StationKit's v1 API.

Use the matching broadcast adapter from `station-adapter-sqlite`,
`station-adapter-postgres`, `station-adapter-mysql`, or
`station-adapter-redis`. In a Station Network, Headquarters reconciles the DAG
while execution stations claim its signal runs.

## License

MIT
