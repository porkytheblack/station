# Sandbox, Browser Use and process runtimes

Station 3.0.0 provides separate server execution primitives. `station-browser` instead runs Station signals/DAGs/beacons inside a browser worker; it does not supply Bash or control server browsers.

## Agent browser integration

Use `createBrowserAgentTools({ client: new BrowserUseClient({baseUrl, stationId,
apiKey}), maxSessions: 2 })` from `station-browser-use/agent`. Mount each descriptor's
`name`, `description`, `inputSchema`, and dispatch `execute(input,{signal})`.
Create one toolset per workflow and call `await tools.close()` in its lifecycle
cleanup. Default access is the tenant API; `access: "operator"` is explicit for
development. Endpoint, key, worker and resource grants are trusted host configuration,
never model arguments. Grant retained sessions/profiles/checkpoints through
`sessionIds`, `profileIds`, `checkpointIds`. Do not share toolsets across tenants.

Tools have prefix `station_browser_`: open, sessions, navigate, observe, interact,
screenshot, checkpoint, resume, close. Observe before choosing semantic targets;
verify effects after mutations. Interact uses exported `browserCommandSchema` and
authoritative runtime validators. `allowedCommands` restricts structured commands;
omit descriptors to restrict other operations. Unsupported backend capabilities
fail explicitly. Human takeover returns busy; never acquire a control token to
override the human. Unknown transport outcomes must be reconciled, not retried blindly.
An uncertain open/resume fences further admission in that toolset;
`uncertainOpenings()` reports its count and `close()` reports unresolved cleanup.
The host must reconcile before assigning resources to a fresh toolset. Definitive
404 responses during close mean the session is already closed, including idle expiry.

Screenshot results carry `images` separately from `data`; connect these to the model's
native image channel. Base64 inside JSON tool text is not vision. The Foundry example
in `examples/19-foundry-browser` shows structural ToolConfig mounting and an image-aware
ModelAdapter bridge. Page text, screenshots and downloaded content are untrusted input.
Bounded text results carry an explicit truncation marker; use narrower observations
and application-owned artifact storage for large transfers.

## Choose the execution boundary

Hosted browsers: `BrowserbaseBrowserAdapter` from `station-browser-use/browserbase` and `SteelBrowserAdapter` from `station-browser-use/steel` reuse Playwright controls through provider CDP. Configure provider credentials/project, a private `rootDir`, fixed `tenantId` and a profile alias allowlist on the worker. Read [REMOTE.md](../../../packages/station-browser-use/REMOTE.md). Remote profiles are operator-managed; remote downloads/traces are disabled. A proxy does not establish tenant isolation: cloud deployment capabilities default false and require verified operator attestation. Uncertain creates fence admission until operator reconciliation; never repeat a create blindly. Remote reliability checks default on; local/container Playwright opt in. On `challenge_required`, pause for human Live takeover. On `rate_limited`, inspect diagnostics and wait. Agent tools must never acquire a human control lease to bypass the pause. Provider keys/CDP URLs must not enter model arguments or logs.

- `HostSandboxAdapter` from `station-sandbox`: trusted POSIX commands, files, supervised services and optional Node PTYs. `isolated: false`; directories and HOME are organizational, not security boundaries.
- `ContainerSandboxAdapter` from `station-sandbox/container`: one Linux Docker/Podman container and persistent named volume per workspace. Nonroot, read-only root, dropped capabilities, no-new-privileges, bounded CPU/memory/PIDs, no host socket/mounts exposed to code. Requires an operator-managed engine and pre-pulled tools image. Call `ready()` before admission.
- `PlaywrightBrowserAdapter` from `station-browser-use/playwright`: host browser sessions with rich controls and optional persistent profiles. Browser process separation does not isolate unrelated tenants.
- `BunBrowserAdapter` from `station-browser-use/bun`: subprocess per session and basic navigation/evaluation/click/type/press/screenshot. It does not implement Playwright's advanced APIs. Read advertised capabilities.
- Container browser execution is the isolated backend for customer sessions; use the package's container reference and operator image. Never silently substitute a host browser.

The controller runtime, signal/beacon `ProcessRuntime`, browser backend and sandbox backend are independent choices. `BunProcessRuntime` from `station-signal` selects Bun child bootstraps; Node remains the default. Benchmark real workloads before claiming throughput gains. Native PTYs currently require a Node controller; Bun programs can run as children inside them.

## Sandbox API

For the full sandbox lifecycle, a runnable offline CLI installation/recovery example, Git credential integration, exact tenant RPC payloads and deployment boundaries, read [the detailed Sandbox guide](../../../packages/station-sandbox/GUIDE.md).

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

One active manager owns a root; a second owner fails. Interrupted commands are not automatically replayed. Live PTYs are interrupted on worker restart. Host services require an explicit restart; container services with retained desired-running state relaunch automatically after initialization. Stop a container service explicitly if it must remain stopped after recovery. Host terminal rings are memory-only; container terminals checkpoint a bounded output tail, without restoring the live shell. Container services share command execution slots. Host processes deliberately escaping groups remain outside host-adapter containment. For container workspaces, cancelling/timing out a command, stopping a running service or closing a live terminal always stops the entire workspace container, including escaped process sessions. Other active commands, terminals and services become interrupted and are not automatically replayed by service policies. Files and installed tools persist; the next file/command/terminal/service operation waits for old handles and starts a fresh container. Restart interrupted services explicitly. Other workspaces are unaffected. Failed containment leaves the workspace unavailable. Ordinary completed-command cleanup uses controller-captured process identity, never workload-writable markers.

## Persistent account workflows and media

For WhatsApp, TikTok or Instagram browser workflows, read [the account workflow guide](../../../packages/station-browser-use/REMOTE.md#account-workflows-whatsapp-tiktok-and-instagram). Use a tenant/service/account profile grant and serialize its use. A session ending is not an account logout. Steel saves profile changes on release; the operator must wait for provider `READY` before reuse. Station does not provision profiles or automatically wait for uploads. Verify authentication after each reopen and request human login when necessary. Only WhatsApp QR linking was live-tested; authenticated profile reuse and TikTok/Instagram workflows remain unverified.

Inline browser uploads allow at most 16 files and 4 MiB total decoded bytes. They do not constitute permission to publish/send. Remote Steel/Browserbase downloads remain unsupported. Local/container download artifacts are session-owned and must be exported before close. Large-video uploads, remote downloads and a shared sandbox/browser artifact store are proposed work, not available APIs. Do not invent artifact-reference commands, assume a shared filesystem, or expose raw profile credentials to agents.

## Browser API

```ts
import { BrowserSessionManager } from "station-browser-use";
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";
const browsers = new BrowserSessionManager(
  new PlaywrightBrowserAdapter({ profileRootDir: "/data/profiles", timeoutMs: 30_000 }),
  3, { recordingRootDir: "/data/recordings", stateRootDir: "/data/browser-state", idleTimeoutMs: 900_000 },
);
const session = await browsers.open({ profileId: "research" });
await browsers.perform(session.id, "navigate", "https://example.com");
await browsers.execute(session.id, { op: "fill", selector: "#query", value: "Station" });
const png = await browsers.perform(session.id, "screenshot");
await browsers.closeSession(session.id);
await browsers.close();
```

Basic actions are navigate/evaluate/click/type/press/screenshot. Type targets the focused element. Evaluate JSON-compatible values; use an IIFE for multi-statement Bun expressions. PNG responses contain mimeType and base64. Concurrent actions on one session fail `busy`. Never automatically repeat a timed-out mutation.

Direct navigation and new pages accept absolute HTTP(S) URLs without embedded credentials, plus `about:blank`. Reject local files, executable schemes and browser-internal URLs. Playwright also guards document requests and closes unexpected non-web popup/frame navigations; normal `about:srcdoc` frames and Chromium network-error pages are allowed. These checks do not enforce domain/IP egress policy. Host Playwright launches Chromium with an allowlisted environment and private temporary home, excluding worker credentials and loader overrides. This is not an OS boundary; untrusted tenants still require isolated workers.

`execute(id, command)` supports fill, select, check, hover, scroll, waitFor, content, back/forward/reload, pages/newPage/selectPage/closePage, upload, download/downloadRead/downloadDelete. Read exported `BrowserCommand` for exact fields. Upload bytes are bounded base64, not host paths; downloads return a session-owned artifact ID then bounded bytes. Download artifacts expire with the session. Profile IDs are validated logical names; no arbitrary host path. `listProfiles/deleteProfile` manage saved profiles and reject active deletion/concurrent opens. Manager idle eviction defaults to 15 minutes; recording ticks do not extend activity. Audit metadata is bounded; configure `stateRootDir` for durable sequence-numbered action history and explicit checkpoints. It is not an immutable compliance ledger.

## Semantic browser control, inspection and diagnostics

Check `locators`, `inspection`, `pointer`, `dialogs`, `diagnostics` and `tracing` capabilities. Playwright and container Playwright implement them; Bun does not. Existing fill/select/check/hover/waitFor/upload/download operations accept exactly one of `selector` or `target`. New structured click/focus/press do too; press carries `key`.

Targets are `{by:'selector'|'text'|'label'|'testId',value,exact?,frame?,nth?}` or `{by:'role',role,name?,exact?,frame?,nth?}`. `frame` is an iframe-selector chain (maximum8); `nth` is a zero-based match (maximum999). Targets are strict and bounded; no implicit first-match selection. Prefer accessible roles/names and labels for application controls.

```ts
await browsers.execute(id, {
  op: "click", target: { by: "role", role: "button", name: "Continue", exact: true },
});
await browsers.execute(id, {
  op: "fill", target: { by: "label", value: "Code", frame: ["#payment"] }, value: "1234",
});
const view = await browsers.execute(id, { op: "inspect", maxElements: 100, maxTextLength: 256 });
const aria = await browsers.execute(id, { op: "accessibility", depth: 10, boxes: true });
```

`inspect` returns URL/title, bounded DOM elements, `truncated` and `coordinateSpace` (`main-viewport` or `frame-viewport`). Limits:500elements,4096characters/field,4MiB response. Password/file input values are omitted. `accessibility` returns `{format:'aria-yaml',snapshot}` with depth≤20 and1MiB maximum output. Inspection is a snapshot; resolve semantic targets again after page changes.

`mouseClick{x,y,button?,clickCount?}` and `mouseMove{x,y}` use main screenshot viewport CSS pixels. `drag{source,destination}` uses targets; `dragCoordinates{from:{x,y},to:{x,y},steps?}` releases the mouse on error. Do not apply frame-local inspection boxes directly to main-viewport coordinates.

`dialog{action:'accept'|'dismiss',promptText?,expiresInMs?}` arms one next selected-page dialog, default10s/max30s. All other dialogs dismiss immediately. It never leaves an unresolved modal waiting for a later RPC. Prompt contents and answers are absent from diagnostic events.

`diagnostics{consoleText?,clear?}` returns at most200 recent console/network/dialog events plus trace state. Default console text is absent; URL credentials/query/fragment and network bodies/headers are omitted. Console text opt-in captures future text bounded to2KiB/event; arbitrary application secrets may remain in that explicitly requested text. Turning it off purges retained console text.

`traceStart` explicitly records screenshots/DOM snapshots (no source files); `traceStop` returns a ZIP artifact. Trace contents can include sensitive application data. Retrieve/delete via downloadRead/downloadDelete. Artifacts share existing byte/count limits and expire with the session. Traces abort/discard at60s or monitored raw-byte budget; status limit/error cannot export a partialZIP. Enforce OS/container storage quotas for transient growth between50ms samples.

## Live view, human leases and durable checkpoints

`liveFrame(id)` returns `{mimeType:'image/png',base64,capturedAt}` without renewing activity; on busy, skip/retry a later view tick. It is screenshot polling, not video. `acquireControl(id,ttlMs?)` grants an exclusive live token, default30s/range1–120s. Use `renewControl`, `releaseControl` and `control(id)`; status does not expose tokens. While leased, pass `controlToken` as the fourth `perform` argument or third `execute`/second `checkpoint` argument. Wrong/missing/expired tokens reject busy. Remote close uses `requestCloseSession` to honor the lease; direct closeSession is privileged lifecycle cleanup. Leases do not persist through worker restart.

`stateRootDir` enables bounded atomic action history plus checkpoints. Use a distinct root from profiles/recordings and supply the matching constructor `tenantId` when reopening tenant-bound roots. Audit action start is persisted before execution and finish afterward; write failure stops action admission. Started without finished has unknown outcome—never automatically replay. Audit retains newest1000 entries by default (max10000), uses monotonic sequence/phase fields, and omits command values/URLs/secrets. Combined state journal≤8MiB; `statePersistence` reports disk/memory.

`checkpoint(id,token?)`, `listCheckpoints`, `deleteCheckpoint(id)` and `resumeCheckpoint(id)` save/open explicit recovery descriptors; at most64 checkpoints. They capture backend/open options, selected page and HTTP(S) origin/path URLs with userinfo/query/hash removed (`about:blank` allowed). Resume creates a new session on the same backend; it is never automatic. Persistent profiles can restore cookies after old ownership ends, not JS/DOM memory, filled forms, pending requests or exact workflow progress. Re-navigation may have effects; request it intentionally. Stable owner storage plus external fencing is required for failover.

## Screenshot playback

`startRecording(sessionId)` captures every 5000ms by default independently of the dashboard. A busy session skips that tick; no screenshot backlog is queued. Use `listRecordings/getRecording/recordingFrame/stopRecording/deleteRecording`. Recording and frame IDs are separate from session IDs. Metadata omits image bytes. Default bounds: 120frames/recording, 16recordings,64MiB retained PNG bytes. Reaching limits stops capture while retaining prior frames.

Memory is the default store. `recordingRootDir` enables atomic disk-backed metadata/PNG storage, exclusive root ownership and restart recovery; TTL defaults to seven days. Recovery retains frames as stopped recordings, not a resurrected browser. `recordingPersistence` reports memory/disk. Profile and recording roots must be distinct and attached to the same logical worker on replacement. Backup those volumes separately from Station's database. Browser tabs/process memory are never restored.

## Headquarters API and dashboard

Private workers configure `execution:{token,sandbox}` or `{token,browser}`. Headquarters configures `{token}`. Keep the minimum32-character service secret exclusively on trusted services. An authenticated admin session/key operates `/sandboxes` and `/browser-use`. `GET /api/v1/execution` advertises actual backend capabilities and availability. Dashboard tools include terminals, file transfer, service controls, page/profile controls and timed recording playback.

Operator RPC: `POST /api/v1/stations/:stationId/execution/:primitive` with JSON. Keep the owner station ID with every resource ID; no implicit migration/retry. Sandbox method names match adapter methods, with `id`, `serviceId` or `terminalId`; create/open/start calls use `options`. Browser RPC uses `open` with optional options; `action` with id/action/value; `execute` with id/command; `profiles/profileDelete/audit`; liveFrame/control/controlAcquire/controlRenew/controlRelease; checkpoint/checkpoints/checkpointDelete/checkpointResume; recordingStart/Stop/Frame/Delete plus recordings/recording. File writes use `{method:'writeFile',id,path,options:{base64,createParents:true}}`.

Gateway rejects unauthenticated/unauthorized, stale/offline/wrong-network owners and redirects. Workers verify a distinct service bearer token. Draining permits inspection and cleanup, refuses admission/mutations. Ordinary request limit128KiB; upload envelope8MiB with at most4MiB decoded file content; response envelope33MiB. Adapter limits can be smaller. A timeout leaves outcome unknown: inspect before retrying.

Public customers must use tenant-scoped execution routes, never administrator credentials or the operator dashboard. Dedicated tenant workers require isolated and network-restricted backends; tenant ownership comes from operator-mapped verified key IDs, never a customer-supplied tenant header. See the tenant deployment contract for exact configuration and routes. Do not expose private worker HTTP or engine APIs.

## Deployment limits

Default container networking is none. Ordinary bridge networking exposes private destinations and metadata and is unsuitable for customer workloads. A named network may be marked restricted only when the operator has independently enforced and verified egress rules; the flag does not install a firewall. Apply hard storage quotas to named volumes and recording/profile disks, reserve host capacity, patch the kernel/engine/images, and define backups/retention. Code can write disk outside captured command output; application byte limits alone do not provide a hard disk quota.

For browser internet access, `scripts/execution-container/enforced/README.md` supplies the tested local rootful Linux Docker/XFS profile: dedicated internal bridge, HTTPS CONNECT proxy with validated public IPv4 pinning, effective host deny rules and project quotas. Configure its verified named network/proxy, quota-backed `profileStorageRoot`, and separate `stateRootDir`/`recordingRootDir` under the same tenant quota tree. Build the supplied browser image containing the immutable quota syscall guard; it prevents descendants from changing project IDs/inheritance. This profile denies direct traffic, HTTP, UDP/QUIC, IPv6 and private destinations. Run `pnpm test:execution:policy` plus its live kernel/browser harness before admission and reverify after host network changes. This browser profile does not automatically add quotas to Sandbox named volumes.

Shared Postgres coordinates Station membership/jobs; it does not store workspace/profile/recording data. Use one active replica per worker/root and preserve stable tenant ownership of its volumes. This supplies execution primitives, not automatic fleet placement, distributed fencing, live migration, customer onboarding or billing. Validate the exact cloud/OS/image combination before public rollout.

Verification commands: `pnpm test:execution:dashboard`, `pnpm test:execution:containers`, `pnpm test:browser-use`, and the fresh Linux harness under `scripts/execution-linux`. Final release preflight: `pnpm release:dry-run --allow-dirty` during local QA; never publish without the requested release authorization.

`pnpm test:browser-use:tools` checks the real authenticated Headquarters/Playwright
tool path without model inference; `pnpm test:browser-use:bridge` checks native
image delivery. Both are in normal `pnpm test` and release preflight.
`pnpm test:browser-use:agent` is a separate paid real-model test requiring the
Foundry example's configured provider key and built Glove checkout. Its example
limits are 14 turns and 600 output tokens per call, with no agent-level retries.
The explicit `--protocol-only` mode checks Foundry assembly without inference.
Report local browser/protocol success separately from real-model task success;
missing or rejected credentials do not establish either a browser regression or
a successful agent test.

## Container seccomp admission

Both `ContainerSandboxAdapter` and `ContainerBrowserAdapter` require enforced seccomp. For engines with an unconfined default, set `seccompProfile` to an absolute operator-reviewed deny-default JSON file; the adapter validates and stages a private copy. Unsafe or missing policy fails admission, without falling back to host execution. Seccomp does not replace tenant egress restrictions, storage quotas or dedicated worker ownership.


### Review hardening contracts

Tenant Headquarters must configure `execution.targets: {workerId: {endpoint, token, tenantId}}` with a distinct credential for every worker (different from the HQ token), fixed HTTPS origins and operator-owned tenant mappings. Never authorize tenant ownership or credential destinations from heartbeats. Tenant workers require independent `auth`, isolated/restricted adapters and all three internal tenant/worker/network assertions; do not distribute fleet tokens to workloads. The operator-only shared-token transport remains for trusted fleets; never use it for tenant routing.

Session cookies default Secure; `auth.secureCookies:false` is local HTTP only. `trustedProxies` lists exact trusted ingress IPs; no implicit X-Forwarded-For trust. FileLogStorage streams disk reads and retains current and previous segments, each capped at 64 MiB by default. Default pending writes are bounded to 4 MiB, and queries keep the newest 10,000 matching entries or 4 MiB. Oversized/overflow writes are dropped with onError notification. These configurable operational limits are not full audit retention or distributed storage; use an appropriate custom store for those requirements. Dashboard uses `STATION_DASHBOARD_HOST`, default127.0.0.1.
