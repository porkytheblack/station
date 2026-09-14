# station-browser-use

A browser-control primitive for Station workers. It owns live browser sessions through interchangeable Bun WebView and Playwright adapters. It is separate from `station-sandbox` (OS commands and workspaces) and `station-browser` (running Station inside a browser/service worker).

This is an initial implementation, not a production multi-tenant browser service. The package supplies local session lifecycle and operations; deployment, authentication, tenant authorization, durable session ownership and Headquarters routing belong to the application/control plane.

## Bun WebView

A Node-based Station worker can control Bun's built-in browser API through a dedicated Bun subprocess for each session. Station itself does not need to migrate to Bun.

```ts
import { BrowserSessionManager } from "station-browser-use";
import { BunBrowserAdapter } from "station-browser-use/bun";

const browsers = new BrowserSessionManager(new BunBrowserAdapter({
  bunPath: "bun",
  backend: "chrome",
  operationTimeoutMs: 30_000,
}), 4);

try {
  const session = await browsers.open();
  await browsers.perform(session.id, "navigate", "https://example.com");
  const title = await browsers.perform(session.id, "evaluate", "document.title");
  const image = await browsers.perform(session.id, "screenshot");
  // image: { mimeType: "image/png", base64: string }
  console.log(title);
  await browsers.closeSession(session.id);
} finally {
  await browsers.close();
}
```

Install a Bun version that provides `Bun.WebView` and a compatible Chromium-family browser on the worker. The adapter defaults to Chrome on every platform and explicitly disables attaching to an existing personal browser. `chromePath` selects an executable; Bun can otherwise discover installed browsers or Playwright's cache. `backend: "webkit"` is an explicit macOS-only alternative, not a Linux fallback. Viewport dimensions default to 1280 × 720 and accept 1–4096 pixels per dimension.

Bun's Chrome backend shares a browser/profile across views in a Bun process. This adapter therefore uses one Bun process per session, with an ephemeral browser profile. Its child environment contains only PATH, HOME and TMPDIR, not the worker's other environment variables. This is credential hygiene, not filesystem or network isolation.

The [Bun WebView API](https://bun.com/docs/runtime/webview) is experimental. Both browser adapters have passed real Chromium checks on macOS and in a Debian ARM64 container. The Linux fixture harness disables Chromium's own sandbox; Railway, Windows and WebKit deployment validation remain outstanding. No Bun throughput or memory advantage is claimed by these tests.

## Playwright

Install the optional `playwright` peer dependency and its Chromium browser on the worker:

```sh
pnpm add station-browser-use playwright
pnpm exec playwright install chromium
```

```ts
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";

const adapter = new PlaywrightBrowserAdapter({ timeoutMs: 30_000 });
const session = await adapter.open();
try {
  await session.navigate("https://example.com");
  const png = await session.screenshot(); // Uint8Array
} finally {
  await session.close();
}
```

Playwright launches a separate headless Chromium process and ephemeral context for each session. An optional `executablePath` selects the Chromium binary. Provision its [Linux system dependencies](https://playwright.dev/docs/browsers#install-system-dependencies) in the deployment image as appropriate.

## Operations and lifecycle

Both adapters implement `open()` and return a session with:

| Operation | Behavior |
| --- | --- |
| `navigate(url)` | Navigate the session's page. |
| `evaluate(expression)` | Evaluate a JavaScript expression and await its result. Use JSON-compatible values; undefined becomes null. Wrap multiple statements in an IIFE for Bun compatibility. |
| `click(selector)` | Click an actionable element. Use CSS selectors for portability. |
| `type(text)` | Insert text into the focused element; focus with `click` first. |
| `press(key)` | Press a key, such as Enter, Tab or Backspace. Backend-specific chord syntax is not portable. |
| `screenshot()` | Capture the current viewport as PNG bytes. |
| `close()` | Idempotently close the session, interrupting pending work. |

The manager returns opaque handles and base64 PNG results suitable for a transport. It rejects concurrent actions on one handle with `busy`; callers can retry after the current action. Different sessions can operate concurrently. Direct adapter sessions serialize operations and allow up to 64 active/queued calls. Timeouts apply when an operation starts, not to time spent queued.

The manager defaults to four sessions. Opening and closing resources continue to count against capacity. Shutdown stops admission, waits for outstanding opens, closes late arrivals, and attempts every session close even if one fails. Applications must call `close()` during graceful worker shutdown.

Operations default to a 30-second timeout (configurable from 1 to 120,000 milliseconds). A timed-out session is retired rather than left with unresolved browser work; close its manager handle to release capacity. Inputs are limited to 64 KiB of UTF-8; JSON evaluation results to 32 MiB; PNG output to 24 MiB. These are response limits, not hard memory or CPU quotas on the browser. Bun additionally bounds its subprocess response stream.

Bun shutdown terminates its owned POSIX process group, escalates to forced termination after a grace period, and waits for subprocess streams to close. Windows process-tree cleanup is not validated. Forced termination of the entire Station host cannot run application cleanup; a service supervisor/container must own and reap remaining processes.

## Worker-side screenshot recordings

`BrowserSessionManager` can retain a bounded sequence of PNG screenshots independently of an open dashboard. This is a screenshot recording, not an encoded video or a trace of every browser event.

```ts
const browsers = new BrowserSessionManager(new BunBrowserAdapter(), 4, {
  intervalMs: 5_000,
  maxFrames: 120,
  maxRecordings: 16,
  maxTotalBytes: 64 * 1024 * 1024,
});
const session = await browsers.open();
await browsers.perform(session.id, "navigate", "https://example.com");
const recording = browsers.startRecording(session.id);
// Worker timers capture without the caller polling or keeping a page open.
// For this demo, allow two later capture ticks before stopping.
await new Promise((resolve) => setTimeout(resolve, 10_500));
const metadata = browsers.getRecording(recording.id);
const stopped = await browsers.stopRecording(recording.id);
for (const frame of stopped.frames) {
  const png = browsers.recordingFrame(recording.id, frame.id);
  // png: { mimeType: "image/png", base64: string }
}
await browsers.deleteRecording(recording.id);
await browsers.close();
```

The default cadence is one attempt immediately, then every five seconds on the worker. The first returned metadata may contain no frames while the first capture is pending. Busy sessions skip ticks and increment `skipped`; captures never overlap an action or create a backlog. Thus this is a best-effort cadence, not a guarantee of one frame every five seconds. Starting an already-active recording for the same session returns that recording.

Metadata includes `id`, `sessionId`, `backend`, `startedAt`, optional `stoppedAt`, `status`, `intervalMs`, `frames`, retained PNG `bytes`, `skipped`, and an optional sanitized `error`. Each frame has an opaque `id`, `capturedAt` timestamp and PNG byte count. `listRecordings()` and `getRecording()` return defensive copies; PNG data is fetched separately with `recordingFrame()`.

The default limits are 120 frames per recording, 16 retained recordings and 64 MiB of PNG data across the manager. Frame or byte limits stop capture with status `limit` and preserve existing frames; nothing is silently evicted. A new recording beyond the recording-count limit fails with `capacity`. Deleting recordings releases the retained-byte budget. Configurable ranges are 100–3,600,000 milliseconds per tick, 1–10,000 frames, 1–1,024 recordings and 1 byte–1 GiB total PNG data. Individual frames are also capped at 24 MiB. These limits cover retained PNG bytes, not all browser or metadata memory.

`stopRecording()` clears the timer and waits for an in-flight capture; an unfinished frame is discarded on stop. `deleteRecording()` stops capture before removing its retained frames. Closing a session or shutting down the manager stops its recordings and interrupts in-flight screenshots through the browser adapter. A capture failure stops recording with status `error`; existing frames remain available.

Recordings survive closing their live browser session **in the same manager**, and remain readable until explicitly deleted or the worker process restarts. They are held in bounded worker memory, not written to durable storage. A restart loses frames and metadata; an idle worker must remain running for timers to execute. Route recording reads and controls to the worker that owns them.

## Deployment boundaries

Each session belongs to the worker that opened it. A Headquarters service can route subsequent commands to that owner, while different private workers advertise Bun or Playwright capabilities. This package alone does not persist ownership or recover browser memory after a restart.

Profiles are ephemeral: closing, restarting or redeploying loses cookies, open pages and in-memory state. Durable agents can save their own progress externally and create a fresh browser later. Persistent profiles, downloads/uploads, proxy configuration, multi-page workflows, idle eviction and remote browser attachment are not included yet.

A browser session does not constitute a tenant security boundary. It can navigate to addresses and execute page scripts available to its worker. Apply authentication, authorization, network policy and appropriate host/container isolation before exposing browser control to untrusted callers. Do not mount credentials or grant browser workers control of the host container runtime.

## Verification

```sh
pnpm --filter station-browser-use build
pnpm --filter station-browser-use test
pnpm --filter station-browser-use test:browsers
```

Unit tests cover capacity during open/close, shutdown races and failures, serialization, cancellation, timeouts, input bounds, queue bounds and missing executables. Recording tests cover worker ticks, busy skips, frame/global-byte/count limits, defensive copies, errors, deletion and close/shutdown races. The explicit browser test builds the published JavaScript and exercises both real adapters against a local HTTP fixture: navigation, click/type/key input, evaluation, PNG bytes, independent cookies, pending-operation cancellation and closing one session without disrupting another. It requires Bun, Chromium/Playwright and permission to listen on loopback and launch browser processes. Browser tests are separate from the ordinary unit suite.
