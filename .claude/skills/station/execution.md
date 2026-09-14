# Sandbox, Browser Use and process runtimes

Station 2.4.0 provides separate server execution primitives. `station-browser` instead runs Station signals/DAGs/beacons inside a browser worker; it does not supply Bash or control server browsers.

## Choose the execution boundary

- `HostSandboxAdapter` from `station-sandbox`: trusted POSIX commands, files, supervised services and optional Node PTYs. `isolated: false`; directories and HOME are organizational, not security boundaries.
- `ContainerSandboxAdapter` from `station-sandbox/container`: one Linux Docker/Podman container and persistent named volume per workspace. Nonroot, read-only root, dropped capabilities, no-new-privileges, bounded CPU/memory/PIDs, no host socket/mounts exposed to code. Requires an operator-managed engine and pre-pulled tools image. Call `ready()` before admission.
- `PlaywrightBrowserAdapter` from `station-browser-use/playwright`: host browser sessions with rich controls and optional persistent profiles. Browser process separation does not isolate unrelated tenants.
- `BunBrowserAdapter` from `station-browser-use/bun`: subprocess per session and basic navigation/evaluation/click/type/press/screenshot. It does not implement Playwright's advanced APIs. Read advertised capabilities.
- Container browser execution is the isolated backend for customer sessions; use the package's container reference and operator image. Never silently substitute a host browser.

The controller runtime, signal/beacon `ProcessRuntime`, browser backend and sandbox backend are independent choices. `BunProcessRuntime` from `station-signal` selects Bun child bootstraps; Node remains the default. Benchmark real workloads before claiming throughput gains. Native PTYs currently require a Node controller; Bun programs can run as children inside them.

## Sandbox API

```ts
import { HostSandboxAdapter } from "station-sandbox";
const sandbox = new HostSandboxAdapter({ rootDir: "/data/workspaces", enablePty: true });
const ws = await sandbox.create();
const run = await sandbox.exec(ws.id, { command: "node --version", timeoutMs: 30_000 });
// Poll until a terminal status; exec returns immediately.
const result = await sandbox.command(ws.id, run.id);
```

Install the optional `node-pty` peer, including its platform native helper, before enabling terminals. Files/services/commands do not require it. Host defaults include 20 workspaces, four commands, 256KiB combined output, a 30s command timeout with a five-minute configurable ceiling and 100 completed command records per workspace. Container limits are independently configurable; inspect its reference.

Methods:

- `create/list/get/destroy`, `exec/command/cancel`.
- `listFiles(id,path?,{offset?,limit?}?)`, `readFile(id,path,{offset?,length?}?)`, `writeFile(id,path,{base64,createParents?})`, `removeFile(id,path,{recursive?}?)`. Paths are workspace-relative. Reads return base64, totalBytes and nextOffset; stop reading when nextOffset reaches totalBytes and honor worker chunk limits. Symlinks/traversal/special files are rejected by file operations.
- `openTerminal(id,{cwd?,cols?,rows?}?)`, `terminals(id)`, `terminal(id,terminalId,offset?)`, `terminalInput(id,terminalId,data)`, `resizeTerminal(id,terminalId,cols,rows)`, `closeTerminal(id,terminalId)`. Output is a bounded byte-offset buffer; handle truncation explicitly. Reconnect preserves live shell state while the worker lives.
- `startService(id,{name,command,cwd?,restart?})`, `services/service`, `stopService/restartService/removeService`. Restart is `{policy:'never'|'on-failure'|'always',maxRestarts,delayMs}`. Service intent/history persist; restart limits are explicit.

Commands, terminals and services use workspace `node_modules/.bin` then `HOME/.local/bin` on PATH. npm global prefix defaults to `HOME/.local`. A dependency-free custom CLI tarball can be uploaded and installed using `npm install --global --offline --ignore-scripts --no-audit --no-fund ./tool.tgz`, then invoked by name in later commands/terminals/services. Persist the workspace volume to retain installation. Registry installs need a permitted network route. Image tools/native dependencies must be prepared by the operator.

One active manager owns a root; a second owner fails. Interrupted commands are not automatically replayed. Live PTYs are interrupted on worker restart; services follow saved desired state and restart policy. Host processes deliberately escaping groups remain outside host-adapter containment. Container cleanup stops the whole container.

## Browser API

```ts
import { BrowserSessionManager } from "station-browser-use";
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";
const browsers = new BrowserSessionManager(
  new PlaywrightBrowserAdapter({ profileRootDir: "/data/profiles", timeoutMs: 30_000 }),
  3, { recordingRootDir: "/data/recordings", idleTimeoutMs: 900_000 },
);
const session = await browsers.open({ profileId: "research" });
await browsers.perform(session.id, "navigate", "https://example.com");
await browsers.execute(session.id, { op: "fill", selector: "#query", value: "Station" });
const png = await browsers.perform(session.id, "screenshot");
await browsers.closeSession(session.id);
await browsers.close();
```

Basic actions are navigate/evaluate/click/type/press/screenshot. Type targets the focused element. Evaluate JSON-compatible values; use an IIFE for multi-statement Bun expressions. PNG responses contain mimeType and base64. Concurrent actions on one session fail `busy`. Never automatically repeat a timed-out mutation.

`execute(id, command)` supports fill, select, check, hover, scroll, waitFor, content, back/forward/reload, pages/newPage/selectPage/closePage, upload, download/downloadRead/downloadDelete. Read exported `BrowserCommand` for exact fields. Upload bytes are bounded base64, not host paths; downloads return a session-owned artifact ID then bounded bytes. Download artifacts expire with the session. Profile IDs are validated logical names; no arbitrary host path. `listProfiles/deleteProfile` manage saved profiles and reject active deletion/concurrent opens. Manager idle eviction defaults to 15 minutes; recording ticks do not extend activity. Audit metadata is bounded and in memory, not a durable compliance ledger.

## Screenshot playback

`startRecording(sessionId)` captures every 5000ms by default independently of the dashboard. A busy session skips that tick; no screenshot backlog is queued. Use `listRecordings/getRecording/recordingFrame/stopRecording/deleteRecording`. Recording and frame IDs are separate from session IDs. Metadata omits image bytes. Default bounds: 120frames/recording, 16recordings,64MiB retained PNG bytes. Reaching limits stops capture while retaining prior frames.

Memory is the default store. `recordingRootDir` enables atomic disk-backed metadata/PNG storage, exclusive root ownership and restart recovery; TTL defaults to seven days. Recovery retains frames as stopped recordings, not a resurrected browser. `recordingPersistence` reports memory/disk. Profile and recording roots must be distinct and attached to the same logical worker on replacement. Backup those volumes separately from Station's database. Browser tabs/process memory are never restored.

## Headquarters API and dashboard

Private workers configure `execution:{token,sandbox}` or `{token,browser}`. Headquarters configures `{token}`. Keep the minimum32-character service secret exclusively on trusted services. An authenticated admin session/key operates `/sandboxes` and `/browser-use`. `GET /api/v1/execution` advertises actual backend capabilities and availability. Dashboard tools include terminals, file transfer, service controls, page/profile controls and timed recording playback.

Operator RPC: `POST /api/v1/stations/:stationId/execution/:primitive` with JSON. Keep the owner station ID with every resource ID; no implicit migration/retry. Sandbox method names match adapter methods, with `id`, `serviceId` or `terminalId`; create/open/start calls use `options`. Browser RPC uses `open` with optional options; `action` with id/action/value; `execute` with id/command; `profiles/profileDelete/audit`; recordingStart/Stop/Frame/Delete plus recordings/recording. File writes use `{method:'writeFile',id,path,options:{base64,createParents:true}}`.

Gateway rejects unauthenticated/unauthorized, stale/offline/wrong-network owners and redirects. Workers verify a distinct service bearer token. Draining permits inspection and cleanup, refuses admission/mutations. Ordinary request limit128KiB; upload envelope8MiB with at most4MiB decoded file content; response envelope33MiB. Adapter limits can be smaller. A timeout leaves outcome unknown: inspect before retrying.

Public customers must use tenant-scoped execution routes, never administrator credentials or the operator dashboard. Dedicated tenant workers require isolated and network-restricted backends; tenant ownership comes from operator-mapped verified key IDs, never a customer-supplied tenant header. See the tenant deployment contract for exact configuration and routes. Do not expose private worker HTTP or engine APIs.

## Deployment limits

Default container networking is none. Ordinary bridge networking exposes private destinations and metadata and is unsuitable for customer workloads. A named network may be marked restricted only when the operator has independently enforced and verified egress rules; the flag does not install a firewall. Apply hard storage quotas to named volumes and recording/profile disks, reserve host capacity, patch the kernel/engine/images, and define backups/retention. Code can write disk outside captured command output; application byte limits alone do not provide a hard disk quota.

Shared Postgres coordinates Station membership/jobs; it does not store workspace/profile/recording data. Use one active replica per worker/root and preserve stable tenant ownership of its volumes. This supplies execution primitives, not automatic fleet placement, distributed fencing, live migration, customer onboarding or billing. Validate the exact cloud/OS/image combination before public rollout.

Verification commands: `pnpm test:execution:dashboard`, `pnpm test:execution:containers`, `pnpm test:browser-use`, and the fresh Linux harness under `scripts/execution-linux`. Final release preflight: `pnpm release:dry-run --allow-dirty` during local QA; never publish without the requested release authorization.
