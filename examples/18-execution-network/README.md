# Headquarters with separate Sandbox and Browser Use workers

This trusted local example runs three ordinary Station services. Headquarters is the public authenticated gateway. Two private workers own separate primitives: trusted Bash workspaces and live browser sessions. This is an explicit owner-routing API; it does not automatically schedule or migrate sessions. Existing Station signals still use their normal queue and placement policies.

## Run locally

Provide an existing Postgres database and these variables to all three processes:

```sh
export DATABASE_URL='postgres://user:password@localhost:5432/station'
export STATION_EXECUTION_TOKEN="$(openssl rand -hex 32)"
```

Give Headquarters its login credentials:

```sh
export STATION_AUTH_USERNAME=admin
export STATION_AUTH_PASSWORD='choose-a-strong-password'
```

From the repository root, install and build the workspace, then install Chromium:

```sh
pnpm install
pnpm --filter example-18-execution-network... build
pnpm --filter example-18-execution-network exec playwright install chromium
```

Start each service in its own terminal with the same database and execution token:

```sh
pnpm --filter example-18-execution-network hq
pnpm --filter example-18-execution-network sandbox
pnpm --filter example-18-execution-network browser
```

Headquarters listens on port 5700, Sandbox on 5701, and Browser Use on 5702. Open Headquarters, log in, and create an API key with the `admin` scope. Only that public key belongs in clients. The execution token is a separate secret shared exclusively by Headquarters and private workers.

## Dashboard

After signing in to Headquarters with the administrator account, open `/sandboxes` to select a Sandbox worker, create a workspace, run commands, inspect output, cancel work or remove the workspace. Open `/browser-use` for the independent browser session controls, navigation, interaction and screenshots.

The dashboard discovers advertised workers through admin-only `GET /api/v1/execution`. The catalog includes station identity, status, capabilities, backend names and availability; capabilities are not inferred from labels. Selecting a worker binds subsequent actions to that owner. Headquarters remains the browser's public interaction point, while workers and the execution token stay private.

## Install a custom workspace tool

From a selected workspace, install a local dependency-free CLI tarball with:

```sh
npm install --global --ignore-scripts --no-audit --no-fund /data/custom-tool.tgz
```

After the install command completes successfully, invoke its binary by name in a new command. The adapter defaults npm's global prefix to `HOME/.local`, and prepends `workspace/node_modules/.bin` followed by `HOME/.local/bin` to PATH. Project-local npm installs also expose their binaries by name and take precedence over global workspace tools.

Installed tools survive fresh shells and worker restarts when the Sandbox volume survives. Another workspace does not acquire them through its PATH, but this is not filesystem confinement: trusted code still has the worker OS user's file access. npm and any required native tools must already be present on the worker. A dependency-free tarball can be installed with `--offline`; registry dependencies need network access. An operator's explicit `NPM_CONFIG_PREFIX` override changes where npm installs; a custom prefix's bin directory must be added to configured PATH when needed.

## Owner-routed execution

Every operation is a JSON POST to Headquarters. Keep the owner station ID together with each returned workspace or browser session ID. Do not replay a failed creation or other mutation automatically: a transport failure may happen after the worker completed it.

```sh
export STATION_ADMIN_KEY='your-admin-api-key'
curl http://localhost:5700/api/v1/stations/sandbox/execution/sandbox \
  -H "Authorization: Bearer $STATION_ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"method":"create"}'
```

The response is `{ "data": { "id": "...", ... } }`. Use the returned workspace ID:

```json
{ "method": "exec", "id": "WORKSPACE_ID", "command": "node --version && git --version", "timeoutMs": 30000 }
```

Execution returns a command ID immediately. Poll its persisted result using:

```json
{ "method": "command", "id": "WORKSPACE_ID", "runId": "COMMAND_ID" }
```

Sandbox supports `create`, `list`, `get`, `destroy`, `exec`, `command`, and `cancel`, plus file, service and terminal methods listed in the [agent API reference](../../.claude/skills/station/execution.md). `exec` additionally accepts an optional relative `cwd`. Additional APIs provide terminals, supervised services and bounded files. Set SANDBOX_PTY=1 with node-pty installed to enable a persistent interactive shell; the controller must run Node. The host-process adapter organizes trusted processes and does not isolate them from the worker filesystem or other workspaces.

Browser requests go to `/api/v1/stations/browser/execution/browser`:

```json
{ "method": "open" }
{ "method": "action", "id": "SESSION_ID", "action": "navigate", "value": "https://example.com" }
{ "method": "action", "id": "SESSION_ID", "action": "evaluate", "value": "document.title" }
{ "method": "action", "id": "SESSION_ID", "action": "screenshot" }
{ "method": "close", "id": "SESSION_ID" }
```

Other actions are `click` (CSS selector), `type` (text into the focused element), and `press` (key). `list` returns live handles. Screenshots return `mimeType` and `base64` inside `data`. Browser sessions have their own lifecycle and do not require a Sandbox workspace.

Playwright is the default browser adapter. Set `BROWSER_BACKEND=bun` on the browser worker to use Bun WebView in its own subprocesses; install Bun and a compatible Chromium binary in that worker image and set `CHROME_PATH` when necessary. This does not change the main Station process or signal runtime. Validate Bun's experimental browser backend against the exact target Linux image before deployment.

## Service deployment contract

Use three services with independently packaged tools. Sandbox's image needs Bash, Node, Git and any other allowed tools. Browser Use's image needs its selected browser backend and OS dependencies. Headquarters needs neither browser nor workspace tooling.

For a service platform, bind each service to the platform's required interface and port, set each worker's `STATION_ENDPOINT` to its private HTTP address, and expose only Headquarters publicly. Set the same `DATABASE_URL`, network ID and execution token on the three services. Disable service sleeping for workers expected to retain live sessions. These are deployment requirements, not a provisioned or validated cloud deployment.

Mount a persistent volume on the Sandbox worker and point `SANDBOX_ROOT` and `STATION_DATA_DIR` to directories on it. Persist Headquarters' `STATION_DATA_DIR` too so API keys and session secrets survive redeploys. Private workers still need outbound access for downloads, browsers or APIs. Keep worker management endpoints inaccessible to untrusted clients.

Use one process/replica per stable worker ID and Sandbox root. An ordinary platform volume is not a shared multi-worker filesystem. A worker restart preserves saved workspace files and command records when the volume survives, but ends running processes and live browser sessions. Recovery does not restore JavaScript stacks, browser tabs or shells. Existing unfinished command records are marked interrupted. Shared Postgres stores Station membership, signal queues and schedules; it does not store browser memory or Sandbox files.

Draining owners reject new work (`create`, `exec`, `open`, and browser actions), while existing workspace inspection, command polling/cancellation, workspace deletion and browser listing/closing remain available until the owner lease expires. This applies to both Headquarters routing and direct worker operations.

The gateway rejects offline, expired-lease and wrong-network owners, follows no redirects, and never forwards the public API key to a worker. Requests are bounded to 128 KiB and proxied successful responses to 33 MiB (allowing the browser adapter’s 32 MiB JSON output plus its response envelope). A request timeout can leave an operation's outcome unknown; inspect the owner before deciding whether to repeat it.

Deferred: automatic capacity-based environment placement, distributed session ownership/leases, idle eviction, streaming PTYs, stronger per-workspace isolation, migration, billing, and high availability. This slice is for trusted operator-controlled workloads.

## Dashboard integration harness

```sh
pnpm test:execution:dashboard
```

This repository harness targets the built Headquarters dashboard and real private Sandbox and Browser Use workers. It includes installing a custom CLI from a local offline package, running it by name later and checking persistence, alongside browser interaction/screenshots. Prepare the built packages and browser dependencies first. The local end-to-end run passed with separate Headquarters and worker processes, including worker restart, installed-tool persistence, command failures/cancellation/timeouts, both browser backends and screenshot downloads. This does not establish cloud deployment readiness.


## Advanced browser state

The example now persists Playwright profiles under `BROWSER_PROFILE_ROOT` (default `.station/browser/profiles`) and screenshot recordings under `BROWSER_RECORDING_ROOT` (default `.station/browser/recordings`). Mount both on durable storage. The dashboard can choose a profile, manage pages/forms/uploads/downloads, and play five-second recordings after a worker replacement. Live tabs are interrupted; profile data and retained frames survive. Bun remains a basic browser backend and does not expose Playwright-only tools.

## Public customer deployment

This example intentionally uses trusted host adapters and administrator login. Do not issue its admin credentials to customers. Use the [tenant deployment contract](../../scripts/execution-container/README.md) for tenant-scoped keys, dedicated workers, isolated containers and required network/storage controls. The standard example is not a public multi-tenant deployment configuration.
