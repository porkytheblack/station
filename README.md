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
- **Separate daemon and clients** — `station-daemon` runs jobs and the API; `station-runtime-cli` and `station-dashboard` independently connect to local or remote daemons
- **Compiled Station Images** — Publish native or bundled JavaScript signals, broadcast planners and beacons to an operator registry; distribute compatible images across Headquarters workers with explicit environment grants and optional worker pins. See the [complete guide](docs/STATION-IMAGES.md) and [site reference](https://station.dterminal.net/docs/images).
- **Remote triggers** — `configure({ endpoint, apiKey })` to trigger jobs from any service over HTTP
- **Claude Code skill** — AI assistant that knows the full API

## Quick start

```bash
pnpm add station-signal station-daemon station-adapter-sqlite
pnpm add -D station-runtime-cli station-dashboard
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
import { defineConfig } from "station-daemon";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  signalsDir: "./src/signals",
  adapter: new SqliteAdapter({ dbPath: "jobs.db" }),
});
```

```bash
pnpm exec stationd
```

`stationd` runs the configured runners and authenticated v1 API in the foreground.
Start the dashboard separately in another terminal:

```bash
STATION_DAEMON_URL=http://127.0.0.1:4400 PORT=4401 STATION_DASHBOARD_HOST=127.0.0.1 pnpm exec station-dashboard
```

Open `http://127.0.0.1:4401`. Closing the dashboard does not stop the daemon or
jobs. For a remote daemon, set its URL instead. Station 3.0 retires `station-kit`
without compatibility exports; configuration imports now come from
`station-daemon`. The `station` executable belongs to `station-runtime-cli`. See the
[Station 3.0 breaking changes](docs/STATION-3.md) for the complete startup split.

The `SignalRunner` /
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
| [`station-sandbox`](./packages/station-sandbox) | Persistent workspaces, terminals and services with host/container adapters |
| [`station-browser-use`](./packages/station-browser-use) | Browser sessions, live takeover, inspection, traces and durable screenshot playback |
| [`station-expressions`](./packages/station-expressions) | Pure expression AST, validation and workflow mappings |
| [`station-tauri`](./packages/station-tauri) | Local Station sidecar integration for Tauri applications |
| [`station-network`](./packages/station-network) | Fleet membership, capacity reporting, draining, and distributed controller leases |
| [`station-adapter-sqlite`](./packages/station-adapter-sqlite) | SQLite adapter (better-sqlite3) |
| [`station-adapter-postgres`](./packages/station-adapter-postgres) | PostgreSQL adapter (pg) |
| [`station-adapter-mysql`](./packages/station-adapter-mysql) | MySQL adapter (mysql2) |
| [`station-adapter-redis`](./packages/station-adapter-redis) | Redis adapter (ioredis) |
| [`station-daemon`](./packages/station-daemon) | Headless runtime, configuration, authenticated API and `stationd` |
| [`station-client`](./packages/station-client) | Shared authenticated client transport |
| [`station-runtime-cli`](./packages/station-cli) | `station` command, local process management and remote operations |
| [`station-dashboard`](./packages/station-dashboard) | Independently started dashboard for a local or remote daemon |

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

`station-sandbox` supplies persistent workspaces, Bash commands, interactive terminals,
supervised services and file transfer through host or Docker/Podman adapters.
`station-browser-use` independently manages browser sessions, semantic/iframe targeting,
live viewing and human takeover, DOM/accessibility inspection, diagnostics/trace exports,
profiles, uploads/downloads and screenshot playback. Headquarters routes each
operation to its owning private worker. See the
[execution guide](https://station.dterminal.net/docs/execution),
[network example](./examples/18-execution-network) and
[agent reference](.claude/skills/station/execution.md).

Agents can mount `createBrowserAgentTools` from `station-browser-use/agent` against
an authenticated Headquarters connection. Tools scope sessions and profile grants
to a workflow, provide DOM/ARIA observations and image screenshots, and respect
human takeover. The [Foundry agent example](examples/19-foundry-browser) includes
the tool and native-image bridge plus an opt-in real-model verification harness.

The operator dashboard exposes `/sandboxes` and `/browser-use`. Custom npm tools
persist with workspace storage and are available in later commands, terminals
and services. Playwright profiles and five-second screenshot recordings can use
persistent storage; live shells and browser tabs are interrupted on worker restart.
Explicit checkpoints reopen saved page URLs/profile options in a new session; durable
action journals record started/finished outcomes without automatically replaying work.
Bun supports basic browser actions; native terminals require a Node controller.

Host adapters are for trusted workloads. Public customer execution uses separate
tenant-scoped authorization and dedicated workers with isolated, network-restricted
container backends. The included [Linux browser deployment profile](scripts/execution-container/enforced/README.md)
provides an HTTPS proxy, host deny rules and XFS quotas with protected quota metadata.
Operators must deploy and verify those controls on their host; these primitives do not implement customer onboarding, billing, automatic placement
or distributed failover. Node stays the default signal/beacon runtime;
`BunProcessRuntime` independently selects Bun child processes.

Run `pnpm test:execution:dashboard` for real dashboard/private-worker workflows,
`pnpm test:execution:containers` for engine integration and
`pnpm test:browser-use` for browser controls and persistence.
`pnpm test:execution:policy` checks the browser egress proxy and deployment verifier. Release preflight
checks every package before uploads; cloud deployment still needs target validation.

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

Release preflight includes local browser-agent tool and image-bridge checks and
does not require a model-provider key. The optional `pnpm test:browser-use:agent`
test exercises a real Foundry agent through OpenRouter using the
[Foundry example setup](examples/19-foundry-browser/README.md). It incurs provider
usage and is separate from package publication. Passing local browser/protocol
tests does not by itself verify a model completing a browser task.

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
