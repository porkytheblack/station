# Station

Type-safe background jobs, recurring tasks, and DAG workflows for TypeScript.

## Features

- **Signals** — Define jobs with Zod schemas, trigger them from anywhere, execute in isolated child processes with timeout enforcement and automatic retries
- **Broadcasts** — DAG workflow orchestration with conditional branching, fan-out/fan-in, and failure policies
- **Beacons** — Long-running, supervised processes (servers, pollers, clients) with restart policies, exponential backoff, heartbeat stall detection, and graceful shutdown
- **Recurring jobs** — Simple interval syntax (`"every 5m"`, `"every 1h"`)
- **Station Networks** — Scale stateless work across a fleet with atomic leases, per-station and fleet-wide concurrency, placement labels, draining, and a Headquarters control plane
- **Calendar schedules** — Five-field cron expressions with IANA timezones, overlap policy, and explicit misfire handling
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
| [`station-schedules`](./packages/station-schedules) | Runtime interval/cron schedules with atomic occurrence claims |
| [`station-browser`](./packages/station-browser) | Experimental Station execution in Web Workers/service workers with IndexedDB |
| [`station-sandbox`](./packages/station-sandbox) | Trusted native POSIX workspaces and supervised Bash commands |
| [`station-browser-use`](./packages/station-browser-use) | Server browser sessions and screenshots through Bun WebView or Playwright |
| [`station-expressions`](./packages/station-expressions) | Pure expression AST, validation and workflow mappings |
| [`station-tauri`](./packages/station-tauri) | Local Station sidecar integration for Tauri applications |
| [`station-network`](./packages/station-network) | Fleet membership, capacity reporting, draining, and distributed controller leases |
| [`station-adapter-sqlite`](./packages/station-adapter-sqlite) | SQLite adapter (better-sqlite3) |
| [`station-adapter-postgres`](./packages/station-adapter-postgres) | PostgreSQL adapter (pg) |
| [`station-adapter-mysql`](./packages/station-adapter-mysql) | MySQL adapter (mysql2) |
| [`station-adapter-redis`](./packages/station-adapter-redis) | Redis adapter (ioredis) |
| [`station-kit`](./packages/station-kit) | **The entry point** — `defineConfig` + `npx station`: runners, dashboard, v1 API, deploy |

## Documentation

### Browser prototype

Run `pnpm dev:browser` to try signals, broadcast DAGs, and supervised beacons in
Web Workers and service workers with IndexedDB persistence and recovery. See
[`station-browser`](./packages/station-browser) and the
[browser lab](./examples/17-browser). This experimental runtime runs local jobs;
closed-page execution depends on browser wake events. The
[browser guide](https://station.dterminal.net/docs/browser) covers integration,
and [the agent reference](.claude/skills/station/browser.md) provides worker
patterns and the supported API. The docs build includes both browser guides in
`llms.txt` and `llms-full.txt`.

### Server execution primitives

`station-sandbox` provides trusted shell workspaces; `station-browser-use` owns
independent browser sessions through Bun WebView or Playwright. Headquarters can
route admin requests to their exact private worker. See the
[execution guide](https://station.dterminal.net/docs/execution),
[three-service example](./examples/18-execution-network) and
[agent reference](.claude/skills/station/execution.md). These are initial primitives:
no automatic environment placement, tenant isolation or restoration of live
processes/browser sessions. Both primitives pass Linux container checks; a Railway
deployment remains unvalidated.
Node stays the default signal/beacon runtime; `BunProcessRuntime` is an opt-in
child-runtime adapter, independent of browser control.

The administrator dashboard provides `/sandboxes` and `/browser-use`, discovering
advertised workers through `GET /api/v1/execution`. Workspace-local and home-global
npm tools are available by command name and persist with the worker's workspace
volume across new shells/restarts; this does not provide filesystem isolation.
The `pnpm test:execution:dashboard` harness exercises the built
Headquarters/private-worker topology, browser control and a custom offline CLI
installation. See the [validation report](./plans/station-dashboard-validation.md)
for passing SQLite/PostgreSQL dashboard runs and Linux primitive checks.

[station-docs](https://github.com/porkytheblack/station) — Getting started, API reference, examples.

## Claude Code skill

```bash
npx skills add porkytheblack/station
```

Teaches Claude how to build with every Station package. Covers signals, broadcasts, adapters, runners, subscribers, remote triggers, and dashboard configuration.

## Releasing to npm

All 16 public packages, including experimental `station-browser`,
`station-sandbox` and `station-browser-use`, share version
2.4.0. Use Node.js 22 or later with the pinned pnpm version. With dependencies
installed, a clean committed checkout, and npm publish access, run:

```bash
pnpm release
```

The command checks package versions and availability, builds the entire workspace
(including the docs and browser lab), runs typechecks and tests, then packs and
validates every archive before publishing anything. Browser tests use headless
Chromium; the preflight installs Playwright's matching browser if it is missing
(the first run needs a download). Linux hosts need Chromium's system libraries;
use `pnpm --filter example-17-browser exec playwright install --with-deps chromium`
on a fresh CI machine.

Preview the same release without uploads:

```bash
pnpm release --dry-run
```

For local packaging QA on uncommitted work, add `--allow-dirty`; `--skip-checks`
is also restricted to dry runs. Both flags are refused for live publishing.
`release:npm`, `release:npm:dry-run`, and `release:dry-run` remain aliases.

If npm fails after some uploads, run `pnpm release --resume`; exact package
versions already present on npm are skipped, but dependencies are still rebuilt.
Use `--tag next` for a prerelease dist-tag. Before a later release, bump every
public package to the same unused version and commit the regenerated LLM index.
Npm authentication/2FA requirements still apply. Publishing packages does not
merge the PR or deploy the documentation site.

## License

MIT
