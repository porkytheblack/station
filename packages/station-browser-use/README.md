# station-browser-use

Browser sessions, structured browser commands, file artifacts and bounded screenshot recordings for Station workers. This primitive is separate from `station-sandbox` (OS workspaces and commands) and `station-browser` (Station running inside a browser/service worker).

A manager owns live sessions on one worker. Applications provide authentication, authorization, routing to that owner, worker supervision and deployment isolation. This package does not make a browser process a tenant security boundary.

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

`execute(sessionId, command)` accepts the exported `BrowserCommand` union. `validateBrowserCommand` and `validateBrowserOpenOptions` are exported for transports and reject unknown fields, invalid identifiers and malformed data.

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

Sessions expire after 15 minutes of inactivity by default; per-manager/per-open timeouts accept 100 ms–24 hours. Commands renew activity, while recording ticks and dashboard metadata polling do not. Thus unattended recording ends when its session expires. A bounded `audit()` history (default 1,000 events) reports opens, closes, idle expiry and action outcomes without URLs, command values, file contents or proxy credentials. Audit history is in memory and is not a compliance log.

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
