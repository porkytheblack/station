# station-browser-use

Browser sessions, structured browser commands, file artifacts and bounded screenshot recordings for Station workers. This primitive is separate from `station-sandbox` (OS workspaces and commands) and `station-browser` (Station running inside a browser/service worker).

A manager owns live sessions on one worker. Applications provide authentication, authorization, routing to that owner, worker supervision and deployment isolation. This package does not make a browser process a tenant security boundary.

## Give an agent browser tools

`station-browser-use/agent` exports an authenticated client and framework-neutral
tool descriptors. Create a toolset per authorized workflow:

```ts
import { BrowserUseClient, createBrowserAgentTools } from "station-browser-use/agent";

const tools = createBrowserAgentTools({
  client: new BrowserUseClient({
    baseUrl: "https://station.example.com",
    stationId: "tenant-browser-worker",
    apiKey: process.env.STATION_EXECUTION_KEY!,
  }),
  maxSessions: 2,
  profileIds: ["research"], // Explicit host grant; no profile access by default.
});
try {
  // Mount each tool's name, description and inputSchema in your framework.
  // Dispatch to tool.execute(input, { signal }).
  // Deliver result.images through the model's image channel, separately from data.
  await runYourAgent(tools);
} finally {
  await tools.close();
}
```

Tools: `station_browser_open`, `station_browser_sessions`,
`station_browser_navigate`, `station_browser_observe`, `station_browser_interact`,
`station_browser_screenshot`, `station_browser_checkpoint`,
`station_browser_resume` and `station_browser_close`. `interact` exposes the full
structured command schema, including semantic targets, frames, pointer input,
page selection, files and diagnostics. `observe` provides bounded DOM or
accessibility data. Screenshots return `{ status, data: { mimeType, bytes },
images: [{ mimeType, base64 }] }`. JSON-stringifying image bytes into a tool result
does **not** give the model vision. The [Foundry example](../../examples/19-foundry-browser/README.md)
demonstrates tool mounting and native image observations.

The model cannot choose the Headquarters URL, credentials, worker, tenant or
human-control token. Only sessions created by the toolset or explicitly granted
in `sessionIds` are addressable. `profileIds` and `checkpointIds` are explicit host
grants; save returned resource IDs in trusted workflow state for later runs.
`allowedCommands` restricts structured commands, including `observe`; choose
which descriptors to mount when also restricting lifecycle/navigation tools.
The server enforces actual backend capabilities and tenant ownership.

Inputs are validated before dispatch. Results exceeding `maxResultChars`
(32,768 by default) are explicitly truncated. Use narrower inspection targets;
retrieve large download artifacts through application code rather than model
context. Website content and files are untrusted data.

Requests have bounded timeouts and response sizes, refuse redirects and never
retry mutations. A dispatched request that loses its response can report
`error.outcome: "unknown"`; reconcile worker state before repeating it. An unknown
open may allocate a session requiring operator discovery or worker idle expiry.
The toolset then fences further opens/resumes and `close()` reports unresolved
cleanup; `uncertainOpenings()` exposes the count. Reconcile before granting resources
to a fresh toolset. A definitive missing-session response during close is treated
as already closed, so idle expiry does not permanently consume workflow capacity.
Human takeover returns a conflict; cleanup does not bypass its lease. `close()`
stops admission and surfaces cleanup failures for later retry after release.

The default client access is `tenant`, using execution-only keys and isolated
private workers. Use explicit `access: "operator"` for an operator development
integration. HTTPS is required except HTTP loopback for local development.

## Configure a worker

```ts
import { BrowserSessionManager } from "station-browser-use";
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";

const browsers = new BrowserSessionManager(new PlaywrightBrowserAdapter({
  profileRootDir: "/data/browser-profiles",
  timeoutMs: 30_000,
  viewport: { width: 1280, height: 720 },
  maxPages: 8,
  maxArtifacts: 16,
  maxArtifactBytes: 4 * 1024 * 1024,
}), 4, {
  recordingRootDir: "/data/browser-recordings",
  recordingTtlMs: 7 * 24 * 60 * 60 * 1000,
  idleTimeoutMs: 15 * 60 * 1000,
  intervalMs: 5_000,
  maxFrames: 120,
  maxRecordings: 16,
  maxTotalBytes: 64 * 1024 * 1024,
  auditLimit: 1000,
});

const session = await browsers.open({ profileId: "research" });
try {
  await browsers.perform(session.id, "navigate", "https://example.com");
  const title = await browsers.perform(session.id, "evaluate", "document.title");
  const png = await browsers.perform(session.id, "screenshot");
  // png: { mimeType: "image/png", base64: string }
  console.log(title);
} finally {
  await browsers.closeSession(session.id);
}
// Call during graceful worker shutdown, after stopping admission to your API:
await browsers.close();
```

Install the optional `playwright` dependency and Chromium in the worker image:

```sh
pnpm add station-browser-use playwright
pnpm exec playwright install chromium
```

Provision [Linux browser dependencies](https://playwright.dev/docs/browsers#install-system-dependencies) as appropriate. `executablePath` selects an installed Chromium binary. An operator can configure `proxy: { server, bypass?, username?, password? }` on the adapter; proxy credentials are not exposed in session or audit metadata and cannot be changed through remote `open` options.

`open()` accepts `profileId`, `viewport` and `idleTimeoutMs`. Viewport dimensions accept 1–4096 pixels. Session handles include creation/activity timestamps and the configured inactivity timeout. Opening and closing sessions count toward the manager's session limit (default four).

## Playwright profiles and pages

Without `profileId`, Playwright launches an ephemeral browser context in a separate Chromium process. With a profile ID, it launches a persistent context in the configured profile root. Persistent cookies and browser storage can survive closing and reopening that profile, including after replacing the adapter/worker. Session cookies follow Chromium's own restart behavior; persistence does not restore live JavaScript stacks or guarantee restoration of open tabs.

Profile IDs are simple opaque identifiers, never filesystem paths. Profiles are unavailable unless `profileRootDir` is configured, and the advertised `profiles` capability reflects that. `listProfiles()` returns IDs and conservative ownership-lock status; `deleteProfile(id)` refuses a profile with a live owner. Only one session/process can own a profile at a time. A dead local process's ownership lock can be recovered on the next open. Treat a browser profile as sensitive authentication material.

A session supports multiple pages sharing its context/profile. Commands act on the selected page. Use `pages`, `newPage`, `selectPage` and `closePage` to manage that selection. The default page limit is eight, configurable from 1–64. Popups count toward the same limit; excess popups are closed. Close the session to close its last page.

## Structured commands

`execute(sessionId, command)` accepts the exported `BrowserCommand` union and returns `unknown`; narrow the result or use the exported result types (`BrowserPage`, `BrowserArtifact`, `BrowserInspection`, `BrowserDiagnostics`) when consuming it in TypeScript. `validateBrowserCommand` and `validateBrowserOpenOptions` are exported for transports and reject unknown fields, invalid identifiers and malformed data.

```ts
await browsers.execute(session.id, { op: "fill", selector: "#query", value: "Station" });
await browsers.execute(session.id, { op: "select", selector: "#category", values: ["research"] });
await browsers.execute(session.id, { op: "check", selector: "#enabled", checked: true });
await browsers.execute(session.id, { op: "hover", selector: "#menu" });
await browsers.execute(session.id, { op: "scroll", x: 0, y: 500 });
await browsers.execute(session.id, { op: "waitFor", selector: "#result", state: "visible" });
const html = await browsers.execute(session.id, { op: "content" });
const page = await browsers.execute(session.id, { op: "newPage", url: "https://example.com" });
```

| Command | Additional fields |
| --- | --- |
| `fill` | `selector`, `value` |
| `select` | `selector`, `values: string[]` |
| `check` | `selector`, `checked: boolean` |
| `hover` | `selector` |
| `scroll` | finite `x`, `y` pixel deltas |
| `waitFor` | `selector`, optional `state`: attached/detached/visible/hidden |
| `content`, `back`, `forward`, `reload`, `pages` | None |
| `newPage` | Optional `url` |
| `selectPage`, `closePage` | `pageId` |
| `upload` | `selector`, `files: { name, mimeType, base64 }[]` |
| `download` | `selector` of the element that starts a download |
| `downloadRead`, `downloadDelete` | `artifactId` |

HTML content is capped at 4 MiB. Uploads contain bytes, not paths: at most 16 files and 4 MiB decoded data total. File names cannot contain path separators. A download click returns `{ id, name, mimeType, bytes, createdAt }`; `downloadRead` adds its base64 data. Artifact names are display metadata and are never used as output paths. MIME type is conservatively `application/octet-stream`.

Downloads have a default aggregate retained-data budget of 4 MiB and 16 artifacts per session; configurable maxima are 16 MiB and 128 artifacts. Delete artifacts to reclaim capacity. Unexpected downloads are cancelled. An active download's temporary files are monitored and oversized downloads cancelled; retained output is checked again before storage. Browser disk writes can overshoot between checks, so use an OS/container storage quota for a hard disk bound. Download temporary files are cleaned after the operation or browser shutdown. Download artifacts are held in session memory and are lost when the session closes.

## Existing basic operations and Bun

The existing `perform(id, action, value?)` interface remains available for `navigate`, `evaluate`, `click`, `type`, `press` and `screenshot`. `type` inserts text into the focused element; focus it first. Use CSS selectors and simple keys such as Enter or Backspace for portability. Evaluate JSON-compatible expressions; undefined becomes null. Wrap multiple statements in an IIFE for Bun compatibility.

```ts
import { BunBrowserAdapter } from "station-browser-use/bun";
const browsers = new BrowserSessionManager(new BunBrowserAdapter({
  bunPath: "bun",
  backend: "chrome",
  chromePath: "/usr/bin/chromium",
  operationTimeoutMs: 30_000,
}));
```

Bun's built-in [WebView API](https://bun.com/docs/runtime/webview) remains experimental. The adapter forces a fresh browser and uses one Bun subprocess per session to avoid sharing Chrome profile state between unrelated sessions. A Node Station controller can use this adapter without migrating itself to Bun. Chrome is the default on all platforms; WebKit is an explicit macOS-only option.

The Bun adapter supports the basic operations, ephemeral independent sessions, per-open viewport and screenshot recording. It explicitly advertises **no profiles, multiple-page commands, uploads or downloads**. Unsupported profile opens or structured commands fail; they do not fall back silently to another backend. Linux requires a compatible installed Chromium-family browser. The adapter strips worker environment variables except PATH, HOME and TMPDIR, which is credential hygiene rather than filesystem isolation.

## Screenshot recordings and durability

```ts
const recording = browsers.startRecording(session.id);
const current = browsers.getRecording(recording.id);
const all = browsers.listRecordings();
const stopped = await browsers.stopRecording(recording.id);
for (const frame of stopped.frames) {
  const png = browsers.recordingFrame(recording.id, frame.id);
}
await browsers.deleteRecording(recording.id);
```

Recording is a sequence of PNG screenshots, not an encoded video or event trace. Capture starts immediately, then runs every five seconds on the worker independently of the dashboard. Busy ticks are skipped and counted rather than queued. The initial result may have no frames until its first capture completes. Starting an already-active recording for a session returns that recording.

Metadata includes recording/session/backend IDs, timestamps, status (`recording`, `stopped`, `limit`, `error`), interval, frame metadata, byte count, skipped ticks and an optional sanitized error. Frame metadata contains its ID, capture timestamp and PNG byte count. Metadata reads return defensive copies; frame bytes are retrieved separately.

Without `recordingRootDir`, recordings use memory. With a dedicated root, frames and metadata are written atomically with file/directory synchronization. Frames commit before metadata references them. Only one manager can own a recording root. Recovery checks metadata and frame sizes, marks interrupted active recordings stopped with `recovered: true`, and cleans uncommitted frame files. Corrupt or linked frame files fail recovery rather than being followed. `recordingPersistence` reports `memory` or `disk` for discovery/UI.

Defaults: 120 frames per recording, 16 retained recordings, 64 MiB retained PNG data and seven days of stopped-record retention. A capture limit stops recording and keeps existing frames. Expired stopped recordings are deleted; recovery also removes the oldest stopped recordings if reduced configured byte/count limits require it. No live recording is silently evicted to admit another. PNG data is on disk when configured; memory holds metadata and the current capture rather than every retained frame.

Configurable ranges: interval 100 ms–1 hour; frames 1–10,000; recordings 1–1,024; total PNG data 1 byte–1 GiB; stopped retention 100 ms–365 days. Individual frames are capped at 24 MiB. These limits cover retained artifacts, not browser/profile caches, metadata memory or all temporary disk writes.

Stopping clears the timer and waits for an in-flight screenshot; an unfinished frame is discarded. Session close stops its recordings and interrupts screenshots before waiting. Recordings remain available after that live session closes. Memory recordings disappear on worker restart; disk recordings recover on a new manager pointing at the same volume. Neither mode resumes a browser session automatically.

Profile and recording roots must be distinct dedicated directories. Namespace markers prevent mixing their resource types. Locks are for a single host or mounted volume with reliable exclusive-create semantics, not a distributed fencing protocol. Remote-host or unverifiable owners fail closed. If a process dies during lock recovery itself, the recovery guard may require operator inspection. Storage quotas, backups and a supervisor remain deployment responsibilities.

## Lifecycle and operational limits

Sessions expire after 15 minutes of inactivity by default; per-manager/per-open timeouts accept 100 ms–24 hours. Commands renew activity, while recording ticks and dashboard metadata polling do not. Thus unattended recording ends when its session expires. A bounded `audit()` history (default 1,000 events) reports opens, closes, idle expiry and action outcomes without URLs, command values, file contents or proxy credentials. Audit history is in memory unless `stateRootDir` is configured. The durable journal is bounded operational history, not an immutable compliance archive.

Manager operations reject overlapping work on a session with `busy`. Direct adapter sessions serialize operations with a maximum queue of 64. Operation timeouts default to 30 seconds (1–120,000 ms); they start when execution begins. Timed-out sessions close. Close their manager handles to release capacity. Basic action input is capped at 64 KiB, evaluation JSON at 32 MiB and PNG output at 24 MiB.

Shutdown stops admission, closes late opens, interrupts browsers and releases recording/profile ownership after cleanup. Bun uses an owned POSIX process group and forced termination fallback. Windows process-tree behavior is not validated. Killing the controller abruptly cannot run its JavaScript cleanup; its supervisor must reap remaining processes.

Browser processes can reach the worker's network and filesystem permissions. Apply tenant authorization and network policy before exposing control to callers. Persistent profiles contain credentials. This package does not certify untrusted multi-tenant isolation, crash-consistent network filesystems, unrestricted deployment platforms or a Bun speed advantage.

## Verification

```sh
pnpm --filter station-browser-use build
pnpm --filter station-browser-use typecheck
pnpm --filter station-browser-use test
pnpm --filter station-browser-use test:browsers
```

Unit tests cover lifecycle races, capacity, serialization, timeouts, response bounds, recording persistence/recovery/retention, root locking, path safety, validation and audit redaction. Explicit real-browser tests use built JavaScript and local HTTP fixtures: both Bun and Playwright basic operations, independent cookies and cancellation; Playwright profile reuse after adapter replacement, profile locks, pages, richer actions, uploads/downloads and durable PNG recording recovery. Browser tests require loopback and browser-launch permission and installed runtimes. Target deployment/OS testing remains necessary in addition to local tests.

## Container Playwright backend

`station-browser-use/container` exports `ContainerBrowserAdapter`. It starts one Linux container for each browser session using an operator-managed Docker or Podman engine. It never falls back to a host browser. The controller requires access to that engine; workload containers never receive its socket or credentials.

```ts
import { ContainerBrowserAdapter } from "station-browser-use/container";
import { BrowserSessionManager } from "station-browser-use";

const browsers = new BrowserSessionManager(new ContainerBrowserAdapter({
  engine: "podman",
  rootDir: "/var/lib/station/browser-controller",
  tenantId: "tenant-a",
  image: "registry.example/station-browser@sha256:...",
  network: "none",
}), 4, { recordingRootDir: "/var/lib/station/browser-recordings", tenantId: "tenant-a" });
await browsers.adapter.ready?.();
await browsers.bindTenant("tenant-a");
const session = await browsers.open({ profileId: "agent-browser" });
```

The image must contain Node, Playwright 1.63-compatible Chromium, and this package's compiled `container-worker.js` at `/opt/station/packages/station-browser-use/dist/container-worker.js`. `workerPath` can override that operator-controlled image path. The adapter resolves the configured local image to its immutable image ID before creating containers; it does not pull images. `/home/node` must be owned by UID/GID 1000 in the image so new named profile volumes inherit writable ownership. No host directory is mounted into a session.

Container defaults are nonroot UID/GID `1000:1000`, all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, an init process, 1 CPU, 1 GiB RAM, 256 PIDs, 256 MiB `/tmp`, 128 MiB shared memory, and no external network. A nonpersistent home uses bounded tmpfs. Persistent homes use labeled named volumes, with at most 64 profiles by default (`maxProfiles`, maximum 1024); `deleteProfile` removes the corresponding volume after verifying ownership. Persistent volume disk usage requires an engine/filesystem quota outside this package. Image files are immutable but `/tmp`, `/dev/shm`, and home/profile storage remain writable as configured.

`isolated: true` describes the Linux container boundary, not a separate kernel or a proof of resistance to kernel/browser exploits. `networkRestricted: true` is automatic for `network: "none"`. `bridge` permits external networking and advertises false. A named network can advertise true only with the explicit operator assertion `networkRestricted: true`; the operator must actually enforce its egress policy. Built-in `bridge`, `default`, and `podman` networks cannot use that assertion. Host networking and container-network sharing are rejected. No client API can select a network, image, mount or privilege setting.

The repository's [enforced Linux deployment](../../scripts/execution-container/enforced/README.md) supplies a rootful Docker/XFS profile with a dedicated HTTPS proxy, kernel-enforced egress rules and a shared tenant block/inode quota. Set the operator-only `profileStorageRoot` to its provisioned profile directory and `proxy: { server: "http://PROXY_IPV4:8080" }` to its fixed proxy. Directory-backed profiles require a local Linux Docker engine, matching controller/workload UID, and the repository-built image containing `/usr/local/bin/station-quota-guard`; there is no fallback to an unguarded image. The guard prevents descendants from changing project IDs/inheritance. Workload DNS and IPv6 are disabled when proxy mode is selected. Put `rootDir`, manager `recordingRootDir`, `stateRootDir` and Station metadata beneath the same provisioned tenant quota. These options do not themselves install a firewall or quota; run the deployment verifier before admission. The ordinary named-volume mode remains available for separately enforced storage.

`ready()` verifies the Linux engine, resource-controller support, immutable image, and previously journaled containers. Container names and profile volumes carry controller ownership labels. Restart reconciles old session containers before allowing profiles to be reused. A live controller root has an exclusive ownership lock. `bindTenant(id)` permanently binds controller storage and recording storage to one tenant; a later different or omitted identity is rejected. Pass the same `tenantId` in both the container adapter options and the manager recording options when reopening a bound recording root, so ownership is checked before recovery or retention cleanup. Existing unbound profiles/recordings cannot be adopted by a tenant. These locks are single-host controls, not distributed leases. Station must still authenticate callers and route each tenant only to its assigned worker.

Engine logging is disabled for these containers so screenshot/RPC payloads do not accumulate in daemon log files. Browser commands use bounded JSONL over the attached container's standard streams, with 8 MiB requests and 34 MiB responses. Commands and screenshots retain the same manager/adapter limits. Close interrupts active work, closes Chromium for profile flushing, removes the owned session container, and keeps its profile volume until explicit deletion. If cleanup fails, the adapter fails closed and retains its journal for recovery. `BrowserSessionManager.close()` also closes adapters that implement their optional lifecycle method.

Host Playwright and Bun adapters advertise `isolated: false` and `networkRestricted: false`. They are for trusted worker workloads; the public tenant gateway must enforce an isolated backend and an appropriate network policy. Container tests exercise actual runtime flags and functional separation, but do not establish a complete public multi-tenant security review.

Run the real container integration after building the repository's test image target:

```sh
STATION_CONTAINER_ENGINE=podman \
STATION_BROWSER_CONTAINER_IMAGE=localhost/station-browser-integration:test \
pnpm --filter station-browser-use test:containers
```

The local Podman Linux integration verifies zero effective Linux capabilities, configured CPU/memory/PID limits, nonroot/read-only/no-network containers, no host bind mounts, separate cookies, profile exclusivity and quota, profile reuse after controller replacement, page controls, uploads/downloads, PNG capture, pending-action cancellation and durable recording recovery. It uses a test-only HTTP fixture inside each network-disabled container. It does not validate an external egress-policy deployment or a hostile-tenant penetration test.

## Semantic targeting, inspection and pointer control

Playwright and the container Playwright adapter advertise `locators`, `inspection`, `pointer`, `dialogs`, `diagnostics` and `tracing`. Bun advertises false for these capabilities and rejects the structured commands.

Element commands accept either the existing `selector` string or a `target`, never both:

```ts
await browsers.execute(id, {
  op: "fill",
  target: { by: "label", value: "Email", exact: true },
  value: "agent@example.com",
});
await browsers.execute(id, {
  op: "click",
  target: { by: "role", role: "button", name: "Continue", exact: true },
});
await browsers.execute(id, {
  op: "fill",
  target: { by: "testId", value: "code", frame: ["#payment-frame"], nth: 0 },
  value: "1234",
});
```

Targets support `selector`, `role`, `text`, `label` and `testId`. A role target uses `role` and optional `name`; the others use `value`. `frame` is an iframe-selector chain of at most eight entries. Optional `nth` selects a zero-based match, bounded at 999. Without it, ambiguous locators fail instead of silently selecting an element. `exact` controls role/name, text and label matching; test IDs and selector targets retain their normal Playwright matching rules. Target strings are limited to 4 KiB. `fill`, `select`, `check`, `hover`, `waitFor`, `upload` and `download` all support targets; structured `click`, `focus` and `press` do too. A structured `press` carries `key`.

`inspect` returns page/frame URL and title, bounded element metadata and `truncated`. Defaults are 100 elements and 256 characters per field; caller limits cannot exceed 500 elements or 4096 characters. Results larger than 4 MiB are rejected. Password and file input values are omitted. `coordinateSpace` identifies whether boxes are relative to the main viewport or a targeted frame's viewport. These snapshots can become stale after the page changes.

`accessibility` returns `{format: "aria-yaml", snapshot}` using Playwright's [ARIA snapshot API](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot). It accepts a target, optional bounding boxes and a depth limit (default 10, maximum 20), with a 1 MiB response limit. Use this for computed accessible roles/names; `inspect` provides DOM metadata rather than a complete accessibility tree.

`mouseClick` and `mouseMove` take nonnegative main-viewport CSS-pixel `x`/`y` coordinates. Clicks optionally specify `button` (`left`, `middle`, `right`) and `clickCount` (1 or 2). `drag` takes semantic `source` and `destination` targets. `dragCoordinates` takes `from`/`to` points and optional `steps` (1–100, default 10); the mouse button is released even when movement fails.

Dialogs default to immediate dismissal so an unexpected modal does not leave an action waiting. `dialog` arms exactly one subsequent dialog on the selected page, including its frames, with `action: "accept" | "dismiss"`, optional acceptance `promptText`, and `expiresInMs` (default 10 seconds, maximum 30 seconds). Expired policies dismiss; another page never inherits a policy. This follows Playwright's requirement that registered [dialog handlers resolve dialogs](https://playwright.dev/docs/dialogs). Dialog diagnostics record type/action, not prompt contents or answers.

## Bounded diagnostics and opt-in traces

`diagnostics` returns up to 200 recent console/network/dialog events and current trace state. Network events include method, URL and status; URL user information, queries and fragments are removed. Headers, request/response bodies and console arguments are not collected by default. `diagnostics({consoleText: true})` enables future console text capture, clipped to 2 KiB per event and with HTTP/WebSocket URL credentials/query/fragment removed. Arbitrary application secrets in console text cannot be reliably detected: enable it intentionally. Turning it off removes retained console text. `clear: true` clears the event ring.

`traceStart` explicitly enables Playwright screenshots and DOM snapshots (without source files). Traces may contain sensitive page/action/network data. `traceStop` returns a ZIP `BrowserArtifact`; use existing `downloadRead` and `downloadDelete` to retrieve and remove it. Trace ZIPs share the session's artifact count and byte budgets with downloads. They are not durable after session closure.

Active traces stop automatically after 60 seconds or when their monitored raw files exceed the remaining artifact budget. A stopped-on-limit/error trace is discarded; `traceStop` then reports the failure instead of returning a partial archive. File growth is sampled every 50 ms, so an OS/container disk quota is still required for a strict bound on transient disk consumption. Closing a session stops tracing and clears diagnostic/dialog state.


## Human control and live viewing

`liveFrame(sessionId)` returns a current PNG with `capturedAt`; it rejects `busy` during an action and does not queue frames or renew session activity. Live viewing is periodic screenshots, not a video stream or remote desktop protocol.

`control(id)` reports `automation` or `human` and lease expiry, never the lease token. `acquireControl(id, ttlMs?)` returns an exclusive token when no operation/lease is active. The default lease is 30 seconds; allowed durations are 1–120 seconds. Renew with `renewControl(id, token, ttlMs?)` and release with `releaseControl(id, token)`. Expiry returns control to automation. While leased, pass the token to `perform(id, action, value?, token)`, `execute(id, command, token)` and `checkpoint(id, token)`; calls with no token or the wrong/expired token reject `busy` instead of interleaving input. `requestCloseSession(id, token?)` honors the lease; `closeSession` is privileged lifecycle cleanup. Leases are live worker state and do not survive restart.

```ts
const lease = browsers.acquireControl(session.id);
try {
  await browsers.execute(session.id, { op: "mouseClick", x: 200, y: 120 }, lease.token);
  const frame = await browsers.liveFrame(session.id);
} finally {
  browsers.releaseControl(session.id, lease.token);
}
```

## Durable action history and explicit checkpoints

Configure a separate `stateRootDir` alongside `recordingRootDir` to persist bounded action history and checkpoints:

```ts
const browsers = new BrowserSessionManager(adapter, 4, {
  stateRootDir: "/data/browser-state",
  recordingRootDir: "/data/browser-recordings",
  tenantId: "tenant-a", // Must match previously bound storage, when using tenant mode.
  auditLimit: 1000,
});
const saved = await browsers.checkpoint(session.id);
await browsers.closeSession(session.id);
const replacement = await browsers.resumeCheckpoint(saved.id);
const history = browsers.audit();
await browsers.deleteCheckpoint(saved.id);
```

State storage uses exclusive single-worker ownership, atomic metadata commits and tenant verification before recovery. `statePersistence` reports `memory` or `disk`. Durable `audit()` entries have monotonic sequence numbers and action `phase: "started" | "finished"`; the start is committed before the action. Journal write failures stop further action admission. A missing finished entry means the outcome may be unknown: do not replay the mutation automatically. Entries omit URLs, arguments, file contents and credentials. The default history retains the newest 1000 entries (maximum 10000); the combined journal is capped at 8 MiB. Export to an independently managed audit system when longer or immutable retention is required.

`checkpoint(id, controlToken?)`, `listCheckpoints()`, `deleteCheckpoint(id)` and `resumeCheckpoint(id)` require durable state storage for mutation. Checkpoints save validated open options, backend, selected page and sanitized HTTP(S) URLs (plus `about:blank`). URL credentials, queries and fragments are removed intentionally. There are at most 64 retained checkpoints. Resume is an explicit operation that opens a **new session**, navigates those sanitized URLs and selects the recorded page on the same backend. Failed resume closes its new session. It does not automatically resume on worker startup.

A persistent profile may restore saved cookies/browser storage after the old session releases it. Checkpoints do not restore JavaScript memory, live DOM, pending requests, filled forms, exact application state or authenticated query URLs. Re-navigation can itself have effects; inspect the intended destination before explicitly resuming. Keep profile, recording and state roots distinct and mounted to the same logical worker. Single-host locks are not distributed fencing or automatic failover.

## Testing provisioned profile storage

Build the repository's `scripts/execution-container/Containerfile` integration target, then run `pnpm test:containers` in this package with `STATION_CONTAINER_ENGINE=docker` and `STATION_BROWSER_CONTAINER_IMAGE` set to that image. The default suite uses named volumes. On the local Linux Docker host, repeat with `STATION_BROWSER_PROFILE_STORAGE_ROOT` set to a dedicated profile directory provisioned by `scripts/execution-container/enforced/provision.py`; run the trusted test controller as UID/GID1000 with engine access. Use at least 512MiB for this Chromium fixture. Workload containers receive only their individual profile directory, never controller files or the engine socket.

Both modes exercise the real session manager, independent cookies, persistent profile reuse after manager replacement, structured targeting/inspection, multiple pages, file upload/download, trace ZIPs, screenshot recordings and cancellation. Directory mode also verifies the exact bind mount and checks that the actual browser worker inherited both the engine and quota seccomp filters. The default fixture uses loopback with networking disabled. To exercise the provisioned proxy too, set `STATION_BROWSER_CONTAINER_NETWORK` and `STATION_BROWSER_CONTAINER_PROXY` to the verified deployment values and allow `example.com`; this adds real Chromium HTTPS success and metadata-address denial checks. The separate enforced deployment kernel suite verifies XFS hard limits and direct network-policy enforcement.
