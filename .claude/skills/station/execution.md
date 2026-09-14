# Sandbox, Browser Use and process runtimes

This is the initial server execution slice, prepared for Station 2.4.0. Use these APIs for trusted operator-controlled workloads. The packages are separate primitives:

| Package / extension | Purpose |
| --- | --- |
| `station-sandbox` | Native POSIX workspaces and bounded Bash commands, through `SandboxAdapter`. |
| `station-browser-use` | Server-owned browser sessions, interaction and PNG screenshots, through `BrowserAdapter`. |
| `station-browser` | Station jobs inside Web Workers/service workers with IndexedDB. This does not control a server browser or run Bash. |
| `ProcessRuntime` from `station-signal` | Select Node or Bun for signal/beacon child processes. This is independent of the controller runtime and browser backend. |

## Local trusted shell workspaces

```ts
import { HostSandboxAdapter } from "station-sandbox";

const sandboxes = new HostSandboxAdapter({
  rootDir: "/data/workspaces",
  maxEnvironments: 8,
  maxConcurrent: 3,
  maxOutputBytes: 256 * 1024,
  maxTimeoutMs: 300_000,
  maxHistoryPerSandbox: 100,
  env: { PATH: "/opt/tools/bin:/usr/local/bin:/usr/bin:/bin" },
});
const sandbox = await sandboxes.create();
const run = await sandboxes.exec(sandbox.id, {
  command: "node --version && git --version",
  timeoutMs: 30_000,
});
// Poll until finishedAt; exec only starts the command.
console.log(await sandboxes.command(sandbox.id, run.id));
// On worker shutdown, interrupt active commands and retain saved files:
await sandboxes.close();
```

The worker must provide Bash and native tools. Commands start fresh noninteractive shells; files persist, shell variables do not. `cwd` is an existing relative directory within the workspace. File operations currently use commands. `cancel` waits for process cleanup; `destroy` refuses while commands are active and deletes workspace files after cleanup.

### Install a custom CLI once, then use its name

Every command prepends `workspace/node_modules/.bin` and `HOME/.local/bin` to the configured or host PATH. `NPM_CONFIG_PREFIX` defaults to `HOME/.local`, so npm global installs stay with the workspace home:

```sh
npm install --global --ignore-scripts --no-audit --no-fund /data/custom-tool.tgz
```

Wait for installation to finish successfully, then run the installed binary by name in a fresh command. Local `npm install` also makes project binaries available by name; project binaries take precedence over home-global and shared host tools. Installations survive new shells and worker restarts when the workspace volume survives. Other workspaces do not acquire these binaries through their PATH. This is not filesystem isolation: commands can still access files permitted to the worker's OS user. An explicit `env.NPM_CONFIG_PREFIX` override changes the install location; add its bin directory to `env.PATH` if needed.

Defaults: 20 workspaces, four running commands, 256 KiB combined captured output, 30 seconds per command with a configurable five-minute maximum, and 100 retained completed command records per workspace. Capture is byte-bounded and UTF-8 aware. Old completed command IDs expire when history is pruned. These are application bounds, not OS CPU/memory/disk or child-process quotas.

Capabilities are `filesystem: true`, `commands: true`, `isolated: false`, `pty: false`. Separate folders and HOME directories do not isolate commands from the host or other workspaces. Only explicitly configured child environment variables plus PATH, locale, HOME and a temporary directory are supplied; the host environment is not inherited wholesale. Commands may still read anything allowed to the worker's OS user.

A single live manager must own each root. Reopening marks leftover running records interrupted and never replays them. No shell, process memory or unpersisted output is restored. The service supervisor must reap orphan processes from a crashed old manager before a replacement takes ownership. Ordinary process groups are cleaned on exit, timeout, cancellation and shutdown; intentionally escaped groups are not contained. PTYs, persistent daemons, file-transfer APIs and stronger isolation remain future adapters/features.

## Browser Use is independent

```ts
import { BrowserSessionManager } from "station-browser-use";
import { BunBrowserAdapter } from "station-browser-use/bun";
// Alternative: import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";

const browsers = new BrowserSessionManager(new BunBrowserAdapter({
  bunPath: "bun",
  backend: "chrome",
  operationTimeoutMs: 30_000,
}), 3);
try {
  const session = await browsers.open();
  await browsers.perform(session.id, "navigate", "https://example.com");
  const title = await browsers.perform(session.id, "evaluate", "document.title");
  const screenshot = await browsers.perform(session.id, "screenshot");
  // screenshot is { mimeType: "image/png", base64: string }.
  console.log(title, screenshot);
  await browsers.closeSession(session.id);
} finally {
  await browsers.close();
}
```

`PlaywrightBrowserAdapter` is available through `/playwright`; install the optional `playwright` peer, Chromium and its OS dependencies on that worker. Bun WebView uses a dedicated Bun subprocess per session, with Chrome selected by default. Install a compatible Bun and Chromium binary; optionally pass `chromePath`. WebKit is an explicit macOS-only option. The Node Station controller does not need to become a Bun application.

Actions: `navigate`, `evaluate`, `click`, `type`, `press`, `screenshot`. Use CSS selectors for portable clicks. `type` inserts into the focused element, so click first. Evaluate JSON-compatible expressions; wrap multiple statements in an IIFE for Bun. Screenshots are viewport PNGs. The manager exposes open, list, perform, closeSession and close; concurrent actions on the same handle fail with `busy`.

Profiles and sessions are ephemeral. Closing or restarting loses tabs, cookies and browser memory. Persist application progress externally, then create a new session explicitly. There are no persistent profiles, browser attachment, upload/download helpers, multi-page API, proxy settings or idle eviction yet. Browser sessions are not tenant isolation boundaries and have the worker's network reachability. Bun's API is experimental. Bun WebView and Playwright passed real Chromium checks on macOS and in a Debian ARM64 container; the Linux fixture harness disables Chromium's own sandbox. Railway deployment and production isolation remain unvalidated. No throughput advantage has been established.

## Headquarters is the public gateway

Start from [example 18](../../../examples/18-execution-network/README.md) in the repository. It supplies three configurations: Headquarters, Sandbox worker and Browser Use worker, using shared Postgres for Station coordination. The two execution primitives have separate ownership and capacity. They do not implicitly allocate one another.

Workers opt in through `defineConfig({ execution: { token, sandbox } })` or `defineConfig({ execution: { token, browser } })`. Headquarters uses `execution: { token }`. The token must contain at least 32 characters and is shared only by the trusted services. Configure normal Headquarters login credentials and create an admin API key for external clients.

### Dashboard and worker discovery

Log in to Headquarters with the configured administrator account. `/sandboxes` provides owner selection, workspace creation, command execution/output, cancellation and deletion. `/browser-use` provides a separate browser-owner selector, session lifecycle, navigation, interaction and screenshots. The browser page is not the browser-local `station-browser` runtime.

The admin-only `GET /api/v1/execution` endpoint returns advertised execution workers with station IDs, names, statuses, capabilities, backend names and an availability flag. Discover workers from this endpoint rather than guessing their capabilities from labels or IDs. Selection remains explicit owner routing; discovery does not schedule or migrate sessions. Keep private worker endpoints and the internal execution token out of public clients.

Public operations use JSON POST requests with an admin API key/session:

```text
/api/v1/stations/:stationId/execution/sandbox
/api/v1/stations/:stationId/execution/browser
```

Persist the selected owner station ID alongside the returned resource ID. The client selects the owner explicitly; this slice does not automatically place environments, maintain distributed session ownership or migrate them. Signal queue placement remains separate.

Sandbox request bodies:

```json
{ "method": "create" }
{ "method": "exec", "id": "WORKSPACE_ID", "command": "node --version", "timeoutMs": 30000 }
{ "method": "command", "id": "WORKSPACE_ID", "runId": "COMMAND_ID" }
{ "method": "cancel", "id": "WORKSPACE_ID", "runId": "COMMAND_ID" }
{ "method": "destroy", "id": "WORKSPACE_ID" }
```

`list` and `get` are also supported; exec accepts `cwd`.

Browser request bodies:

```json
{ "method": "open" }
{ "method": "action", "id": "SESSION_ID", "action": "navigate", "value": "https://example.com" }
{ "method": "action", "id": "SESSION_ID", "action": "screenshot" }
{ "method": "close", "id": "SESSION_ID" }
```

Recording request bodies use the same browser endpoint:

```json
{ "method": "recordingStart", "id": "SESSION_ID" }
{ "method": "recordings" }
{ "method": "recording", "id": "RECORDING_ID" }
{ "method": "recordingFrame", "id": "RECORDING_ID", "frameId": "FRAME_ID" }
{ "method": "recordingStop", "id": "RECORDING_ID" }
{ "method": "recordingDelete", "id": "RECORDING_ID" }
```

Recording is opt-in. The worker takes a viewport PNG immediately and every 5 seconds, independently of dashboard presence; busy ticks are skipped. Dashboard playback supports play/pause and a timestamped scrubber. This is a still-frame sequence, not continuous video or a complete action audit. Start is idempotent while that session is already recording. Browser close stops capture, retaining history until deletion or worker restart. Metadata contains frame IDs/timestamps/byte counts; request each PNG separately. Default limits: 120 frames per recording, 16 retained recordings, 64 MiB total PNG bytes per manager. Limits stop capture without evicting earlier frames. In-memory history is not durable. Avoid enabling capture when page contents should not be retained.

Direct manager equivalents are `startRecording(sessionId)`, `stopRecording(recordingId)`, `listRecordings()`, `getRecording(recordingId)`, `recordingFrame(recordingId, frameId)`, and `deleteRecording(recordingId)`.

`list` is also supported. Successful responses wrap the result in `data`. The gateway checks owner membership, state and lease, rejects offline/expired or wrong-network owners, follows no redirects, and forwards its internal token rather than the public key. Draining blocks new work and browser actions while retaining Sandbox inspection/cancellation/deletion and browser list/close plus recording reads/stop/deletion. It does not fall back to another worker if the owner is unavailable. Requests are capped at 128 KiB and successful proxied responses at 33 MiB, including JSON/base64 overhead.

A timeout can leave an operation's outcome unknown. Do not automatically replay mutations such as open, create or exec: inspect the owner and application state first.

## Deployment and recovery

Use one process/replica per stable worker ID. Advertise reachable private HTTP endpoints for workers; expose Headquarters publicly. Keep the same network ID, Postgres connection and execution token across the services. Provision tools and browser libraries in each worker image, allow required outbound requests, and disable sleeping when retaining live sessions.

Persist Sandbox's workspace root and Station data directory; persist Headquarters' data directory for API keys/session secrets. Postgres stores membership and Station jobs/schedules, not browser memory or Sandbox files. An ordinary service volume is not a shared multi-worker filesystem. Redeployment interrupts commands and browsers; saved workspace files only survive when the volume does. The complete dashboard topology passed locally with SQLite and PostgreSQL. Linux primitive checks passed separately; the complete topology has not been deployed to Railway.

Deferred: automatic environment placement, distributed ownership/leases, migration, idle eviction, streaming terminals, tenant authorization, stronger isolation, high availability and billing. Do not present this slice as a production multi-tenant execution platform.

## Optional Bun signal and beacon children

```ts
import { defineConfig } from "station-kit";
import { BunProcessRuntime } from "station-signal";

export default defineConfig({
  signalsDir: "./src/signals",
  beaconsDir: "./src/beacons",
  processRuntime: new BunProcessRuntime("bun"),
});
```

Node remains the default. The same `processRuntime` option is available on `SignalRunner` and `BeaconRunner`; it selects bootstrap children and preserves Station's JSON IPC contract. Bun loads TypeScript without Node's tsx hook. This does not switch the controller, browser adapter or Sandbox shell and does not provide isolation. Validate native dependencies, signal/beacon behavior and the target OS before rollout. Compare representative Station workloads before claiming faster throughput or lower memory.

Package READMEs define exact options and limits: `packages/station-sandbox/README.md`, `packages/station-browser-use/README.md`. Verify package builds/tests, the real-browser integration test and owner-routing tests; provision the three-service example separately before treating a deployment as verified.

## Full dashboard integration check

The repository's `pnpm test:execution:dashboard` harness exercises the built Headquarters dashboard with real private execution workers, browser control and a dependency-free local npm package installed offline. Its custom-tool path covers install, later plain-name execution and workspace persistence. The command builds the dashboard and requires Bun, Playwright/Chromium and native SQLite support. It also verifies failure output, cancellation, timeouts, workspace deletion, screenshot downloads and closing browsers during pending actions. A passing local run does not establish cloud deployment readiness.
