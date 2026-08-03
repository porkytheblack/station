# Station

Type-safe background jobs, recurring tasks, and DAG workflows for TypeScript.

## Features

- **Signals** — Define jobs with Zod schemas, trigger them from anywhere, execute in isolated child processes with timeout enforcement and automatic retries
- **Broadcasts** — DAG workflow orchestration with conditional branching, fan-out/fan-in, and failure policies
- **Beacons** — Long-running, supervised processes (servers, pollers, clients) with restart policies, exponential backoff, heartbeat stall detection, and graceful shutdown
- **Recurring jobs** — Simple interval syntax (`"every 5m"`, `"every 1h"`)
- **Four adapter backends** — SQLite, PostgreSQL, MySQL, Redis (or bring your own)
- **`station-kit`** — The entry point: one config file and `npx station` wire the runners, a real-time dashboard with auth and WebSocket updates, and an authenticated REST API
- **Remote triggers** — `configure({ endpoint, apiKey })` to trigger jobs from any service over HTTP
- **Claude Code skill** — AI assistant that knows the full API

## Quick start

```bash
pnpm add station-signal station-kit
```

Define a signal:

```ts
// src/signals/send-email.ts
import { signal, z } from "station-signal";

export const sendEmail = signal("send-email")
  .input(z.object({ to: z.string(), subject: z.string(), body: z.string() }))
  .timeout(30_000)
  .retries(2)
  .run(async (input) => {
    await emailService.send(input.to, input.subject, input.body);
  });
```

Configure and run it:

```ts
// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  signalsDir: "./src/signals",
  adapter: new SqliteAdapter({ dbPath: "jobs.db" }),
});
```

```bash
npx station
```

`station-kit` is the entry point: one config file and one command wire the
runners, the dashboard, and the authenticated v1 API. The `SignalRunner` /
`BroadcastRunner` / `BeaconRunner` classes are exported too, but constructing
them by hand is an escape hatch — for embedding Station in a process you already
own, headless workers, or tests.

Trigger from anywhere:

```ts
import { sendEmail } from "./signals/send-email.js";

await sendEmail.trigger({
  to: "alice@example.com",
  subject: "Welcome",
  body: "Thanks for signing up.",
});
```

## Packages

| Package | Description |
|---|---|
| [`station-signal`](./packages/station-signal) | Core framework — signals, runner, queue, adapters |
| [`station-broadcast`](./packages/station-broadcast) | DAG workflow orchestration for signals |
| [`station-beacon`](./packages/station-beacon) | Long-running supervised processes — servers, pollers, clients |
| [`station-env`](./packages/station-env) | Runtime-managed environment variables injected into signal/beacon runs |
| [`station-adapter-sqlite`](./packages/station-adapter-sqlite) | SQLite adapter (better-sqlite3) |
| [`station-adapter-postgres`](./packages/station-adapter-postgres) | PostgreSQL adapter (pg) |
| [`station-adapter-mysql`](./packages/station-adapter-mysql) | MySQL adapter (mysql2) |
| [`station-adapter-redis`](./packages/station-adapter-redis) | Redis adapter (ioredis) |
| [`station-kit`](./packages/station-kit) | **The entry point** — `defineConfig` + `npx station`: runners, dashboard, v1 API, deploy |

## Documentation

[station-docs](https://github.com/porkytheblack/station) — Getting started, API reference, examples.

## Claude Code skill

```bash
npx skills add porkytheblack/station
```

Teaches Claude how to build with every Station package. Covers signals, broadcasts, adapters, runners, subscribers, remote triggers, and dashboard configuration.

## License

MIT
