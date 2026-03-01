# Station

Type-safe background jobs, recurring tasks, and DAG workflows for TypeScript.

## Features

- **Signals** — Define jobs with Zod schemas, trigger them from anywhere, execute in isolated child processes with timeout enforcement and automatic retries
- **Broadcasts** — DAG workflow orchestration with conditional branching, fan-out/fan-in, and failure policies
- **Recurring jobs** — Simple interval syntax (`"every 5m"`, `"every 1h"`)
- **Four adapter backends** — SQLite, PostgreSQL, MySQL, Redis (or bring your own)
- **Dashboard** — Real-time monitoring UI with auth, WebSocket updates, and a REST API
- **Remote triggers** — `configure({ endpoint, apiKey })` to trigger jobs from any service over HTTP
- **Claude Code skill** — AI assistant that knows the full API

## Quick start

```bash
pnpm add station-signal
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

Start the runner:

```ts
// src/runner.ts
import { SignalRunner } from "station-signal";
import { SqliteAdapter } from "station-adapter-sqlite";

const runner = new SignalRunner({
  signalsDir: "./src/signals",
  adapter: new SqliteAdapter({ dbPath: "jobs.db" }),
});

await runner.start();
```

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
| [`station-adapter-sqlite`](./packages/station-adapter-sqlite) | SQLite adapter (better-sqlite3) |
| [`station-adapter-postgres`](./packages/station-adapter-postgres) | PostgreSQL adapter (pg) |
| [`station-adapter-mysql`](./packages/station-adapter-mysql) | MySQL adapter (mysql2) |
| [`station-adapter-redis`](./packages/station-adapter-redis) | Redis adapter (ioredis) |
| [`station-kit`](./packages/station-kit) | Dashboard — monitor and control signals and broadcasts |

## Documentation

[station-docs](https://github.com/porkytheblack/station) — Getting started, API reference, examples.

## Claude Code skill

```bash
npx skills add porkytheblack/station
```

Teaches Claude how to build with every Station package. Covers signals, broadcasts, adapters, runners, subscribers, remote triggers, and dashboard configuration.

## License

MIT
