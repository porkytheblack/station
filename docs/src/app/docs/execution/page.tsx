import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Sandbox and Browser Use — Station",
  description: "Run trusted shell workspaces and server browser sessions on specialized Station workers, with owner routing through Headquarters and optional Bun process children.",
};

export default function ExecutionPage() {
  return (
    <>
      <div className="eyebrow">Execution environments</div>
      <h2 style={{ marginTop: 0 }}>Sandbox and Browser Use</h2>
      <p>
        Station supplies two separate server execution primitives: native shell
        workspaces and live browser sessions. A Headquarters service can expose
        their authenticated API while private, specialized workers own the resources.
        Use the host backend for trusted work. Customer execution requires tenant-scoped
        authorization and isolated, network-restricted container backends.
      </p>
      <table className="api-table">
        <thead><tr><th>Primitive</th><th>Runs where</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>station-sandbox</td><td>POSIX worker</td><td>Persistent files, native Bash and bounded commands through a SandboxAdapter.</td></tr>
          <tr><td>station-browser-use</td><td>Server browser worker</td><td>Navigation, interaction, evaluation and screenshots through Bun WebView or Playwright.</td></tr>
          <tr><td>station-browser</td><td>Web Worker/service worker</td><td>Browser-local Station signals, DAGs and beacons with IndexedDB.</td></tr>
        </tbody>
      </table>
      <p>
        Browser Use does not require a Sandbox workspace. The separate
        <Link href="/docs/browser"> browser runtime</Link> executes Station inside
        the browser; it does not run Bash or control server browser sessions.
        For this checkout, use workspace dependencies and the
        <a href="https://github.com/porkytheblack/station/tree/main/examples/18-execution-network"> execution-network example</a>.
        These additions are prepared for Station 2.4.0 and still require release
        and target deployment validation.
      </p>

      <h3>Native trusted workspaces</h3>
      <Code>{`import { HostSandboxAdapter } from "station-sandbox";

const sandboxes = new HostSandboxAdapter({
  rootDir: "/data/workspaces",
  maxEnvironments: 8,
  maxConcurrent: 3,
  maxOutputBytes: 256 * 1024,
  maxTimeoutMs: 300_000,
  maxHistoryPerSandbox: 100,
  env: { PATH: "/opt/tools/bin:/usr/local/bin:/usr/bin:/bin" },
});
const workspace = await sandboxes.create();
const started = await sandboxes.exec(workspace.id, {
  command: "node --version && git --version && printf hello > greeting.txt",
  timeoutMs: 30_000,
});
// Poll this until finishedAt before treating the result as final.
const result = await sandboxes.command(workspace.id, started.id);
console.log(result.status, result.stdout, result.stderr);
// Graceful shutdown interrupts commands and preserves saved files.
await sandboxes.close();`}</Code>
      <p>
        Install Bash, Node, Git and other native tools in the worker image or host.
        Commands use those real programs; Unix is not emulated. Each command starts
        a fresh noninteractive shell with a separate workspace home. Files persist;
        shell bindings do not. The file API supports bounded reads, writes, uploads and directory listings. An optional
        relative <code>cwd</code> must resolve inside the workspace.
      </p>
      <p>
        The host-process adapter advertises <code>isolated: false</code> and
        <code> pty: true</code> when explicitly enabled on a Node controller. Commands can access everything permitted to the
        worker&apos;s OS user, including other workspaces. Directory validation and
        explicit environment variables organize trusted work; they are not a security
        boundary. Provision OS/container CPU, memory, disk and process limits separately.
      </p>
      <p>
        Defaults are 20 workspaces, four concurrent commands, 256 KiB of combined
        captured output, a 30-second timeout with a configurable five-minute maximum,
        and 100 retained completed commands per workspace. Output is byte-bounded
        and UTF-8 aware; older completed command IDs expire. Ordinary descendants
        are cleaned up on shell exit, cancellation, timeout and shutdown. Deliberately
        escaped process groups are outside this backend&apos;s guarantees.
      </p>

      <h3>Install tools into a workspace</h3>
      <Code>{`npm install --global --ignore-scripts --no-audit --no-fund /data/custom-tool.tgz
# After installation succeeds, run its binary by name in a new command:
custom-tool --version`}</Code>
      <p>
        Commands prepend <code>workspace/node_modules/.bin</code> and
        <code> HOME/.local/bin</code> to the configured or host PATH. npm&apos;s global
        prefix defaults to <code>HOME/.local</code>, so custom tools stay in the
        workspace home. Project-local npm binaries take precedence over workspace
        global tools. npm and required native dependencies must already be installed
        on the worker; a dependency-free local tarball can be installed offline.
      </p>
      <p>
        Tools survive fresh shells and worker restarts when the workspace volume
        survives. Other workspaces do not gain them through PATH. This does not
        restrict filesystem access: trusted commands retain the OS user&apos;s
        permissions. An explicit <code>env.NPM_CONFIG_PREFIX</code> override changes
        installation location; include its bin directory in <code>env.PATH</code>
        when required.
      </p>

      <h3>Terminals, services and files</h3>
      <Code>{`const sandbox = new HostSandboxAdapter({
  rootDir: "/data/workspaces", enablePty: true,
}); // Install optional node-pty; controller must run Node.
const ws = await sandbox.create();
await sandbox.writeFile(ws.id, "hello.txt", {
  base64: Buffer.from("hello").toString("base64"),
});
const terminal = await sandbox.openTerminal(ws.id, { cols: 100, rows: 24 });
await sandbox.terminalInput(ws.id, terminal.id, "node --version\r");
const output = await sandbox.terminal(ws.id, terminal.id, 0);
await sandbox.resizeTerminal(ws.id, terminal.id, 120, 30);
const service = await sandbox.startService(ws.id, {
  name: "app", command: "node server.js",
  restart: { policy: "on-failure", maxRestarts: 5, delayMs: 1000 },
});
await sandbox.stopService(ws.id, service.id);`}</Code>
      <p>Terminal output uses byte offsets and a bounded retained buffer. Reconnect while
        the worker lives; restart interrupts the shell. Service restart policy is explicit,
        bounded and stored with service intent. File APIs reject traversal and symlinks;
        the trusted host backend still cannot confine commands to those paths.</p>
      <h3>Isolated container workspaces</h3>
      <Code>{`import { ContainerSandboxAdapter } from "station-sandbox/container";
const sandbox = new ContainerSandboxAdapter({
  rootDir: "/data/container-state",
  image: "your-registry/station-tools@sha256:YOUR_VERIFIED_DIGEST",
  engine: "docker", // Podman is also supported.
  network: "none", memoryMb: 512, cpus: 1, pidsLimit: 128,
  enablePty: true,
});
await sandbox.ready();`}</Code>
      <p>Provision a Linux engine and pre-pull an operator-controlled image containing
        Node, Bash and setsid. Each workspace has a nonroot container and persistent named
        volume. The adapter drops capabilities, uses a read-only root, bounds CPU/memory/PIDs
        and exposes no engine socket or arbitrary host mounts to workload code. Engine
        access belongs exclusively to the controller. It never falls back to host execution.</p>
      <p>Network access defaults to none. Public customers must not receive unrestricted
        bridge networking: protect cloud metadata, private networks and other tenants with
        an operator-enforced egress policy. Named volumes need storage-level disk quotas;
        command output limits do not limit what a program can write to disk. Root ownership
        locks are local, not distributed fencing.</p>
      <h3>Agent-controlled browser workflows</h3>
      <p>Mount Browser Use as agent tools; use the dashboard to observe sessions or
        take temporary human control. The toolset binds to one authenticated worker
        and scopes resource IDs to a workflow.</p>
      <Code>{`import { BrowserUseClient, createBrowserAgentTools } from "station-browser-use/agent";

const tools = createBrowserAgentTools({
  client: new BrowserUseClient({
    baseUrl: "https://station.example.com",
    stationId: "tenant-browser-worker",
    apiKey: process.env.STATION_EXECUTION_KEY!,
  }),
  maxSessions: 2,
  profileIds: ["research"],
});
// Mount name, description, inputSchema and execute(input, { signal }).
// Feed result.images into the model's native image input channel.
try { await runYourAgent(tools); }
finally { await tools.close(); }`}</Code>
      <p>Tools cover opening sessions, DOM/ARIA observation, navigation, structured
        interactions, screenshots, checkpoints, resume and close. Each name starts
        with <code>station_browser_</code>. The model cannot choose credentials,
        tenant identity, worker or a human-control token. Retained profiles,
        sessions and checkpoints require explicit host grants.</p>
      <p>Screenshot bytes are returned separately from text. The Foundry example
        maps them to native model image observations after tool results have been
        committed. Ordinary JSON containing base64 does not provide vision.
        Treat website content as untrusted data. Text results are bounded and
        explicitly marked when truncated.</p>
      <p>The client defaults to tenant execution-only API keys. Operator access
        requires an explicit development configuration. Requests refuse redirects
        and never retry mutations; an unknown transport outcome requires checking
        worker state. Cleanup respects human control and surfaces failures for retry
        after the lease releases.</p>
      <h3>Independent browser sessions</h3>
      <Code>{`import { BrowserSessionManager } from "station-browser-use";
import { BunBrowserAdapter } from "station-browser-use/bun";

const browsers = new BrowserSessionManager(new BunBrowserAdapter({
  bunPath: "bun", backend: "chrome", operationTimeoutMs: 30_000,
}), 3);
try {
  const session = await browsers.open();
  await browsers.perform(session.id, "navigate", "https://example.com");
  const title = await browsers.perform(session.id, "evaluate", "document.title");
  const image = await browsers.perform(session.id, "screenshot");
  // image: { mimeType: "image/png", base64: string }
  console.log(title, image);
  await browsers.closeSession(session.id);
} finally {
  await browsers.close();
}`}</Code>
      <p>
        Bun uses a dedicated subprocess per session with an ephemeral profile.
        Install a Bun version providing WebView and a compatible Chromium binary;
        <code> chromePath</code> can select its executable. The default backend is
        Chrome; WebKit is an explicit macOS-only option. A Node Station controller
        can manage these Bun children without migrating its own runtime.
      </p>
      <Code>{`// Alternatively use the optional Playwright peer and installed Chromium:
import { PlaywrightBrowserAdapter } from "station-browser-use/playwright";
const browsers = new BrowserSessionManager(
  new PlaywrightBrowserAdapter({ timeoutMs: 30_000 }), 3,
);`}</Code>
      <p>
        Both adapters support navigate, evaluate, click, type, press and screenshot.
        Use CSS selectors; focus an element before typing. Evaluation returns
        JSON-compatible values; wrap multiple statements in an IIFE for Bun.
        Screenshots capture the current viewport as PNG. The manager rejects
        concurrent actions on the same handle with <code>busy</code>.
      </p>
      <p>
        Browser sessions have independent lifecycles and are not tenant isolation
        boundaries. Playwright supports persistent profiles, multiple pages, structured form actions,
        uploads/downloads and operator-configured proxy settings. Configure profileRootDir
        to retain cookies across sessions. Live tabs and process memory are still lost
        on restart. The manager expires idle sessions and retains bounded audit metadata. Bun WebView is
        experimental. Both adapters passed real Chromium checks on macOS and in
        a Debian ARM64 container. Linux fixture tests disable Chromium&apos;s own
        sandbox; they do not establish production isolation, Railway deployment
        support, or a throughput/memory advantage.
      </p>

      <h3>Profiles, page tools and durable recordings</h3>
      <Code>{`const browsers = new BrowserSessionManager(
  new PlaywrightBrowserAdapter({ profileRootDir: "/data/profiles" }),
  3, { recordingRootDir: "/data/recordings", stateRootDir: "/data/browser-state", idleTimeoutMs: 900_000 },
);
const session = await browsers.open({ profileId: "research" });
await browsers.execute(session.id, { op: "newPage", url: "https://example.com" });
await browsers.execute(session.id, { op: "fill", selector: "#query", value: "Station" });
const pages = await browsers.execute(session.id, { op: "pages" });
const recording = browsers.startRecording(session.id);`}</Code>
      <p>Structured operations include fill, select, check, hover, scroll, waitFor, content,
        history navigation, page management and bounded upload/download artifacts.
        Bun advertises only its supported basic capabilities; the dashboard hides unsupported
        tools. A profile can be open only once per owning manager, and storage roots must
        have exactly one live owner. Download and trace artifacts are bounded and session-owned. Configure a separate
        stateRootDir for durable action history/checkpoints; recordings and saved profiles
        have their own storage roots.</p>
      <h3>Semantic targets and page inspection</h3>
      <Code>{`await browsers.execute(session.id, {
  op: "click",
  target: { by: "role", role: "button", name: "Continue", exact: true },
});
await browsers.execute(session.id, {
  op: "fill",
  target: { by: "label", value: "Code", frame: ["#payment-frame"] },
  value: "1234",
});
const page = await browsers.execute(session.id, {
  op: "inspect", maxElements: 100, maxTextLength: 256,
});
const accessible = await browsers.execute(session.id, {
  op: "accessibility", depth: 10, boxes: true,
});`}</Code>
      <p>Targets support selector, role/name, text, label and testId, optional exact matching,
        an iframe-selector chain of up to eight frames, and an explicit zero-based nth match.
        Ambiguous matches fail. Existing form/upload/download operations accept exactly one
        selector or target; click, focus and press are structured operations too.</p>
      <p>Inspection returns bounded DOM metadata, truncation and coordinateSpace. Password
        and file input values are omitted. Defaults are 100 elements and 256 characters per
        field; maxima are 500 elements, 4096 characters and 4 MiB total output. Accessibility
        returns an ARIA YAML snapshot, bounded to 1 MiB and depth 20. Frame-targeted DOM boxes
        use that frame&apos;s viewport; main-page boxes use the main viewport. Re-resolve targets
        after the page changes.</p>
      <p>mouseClick and mouseMove use main-viewport CSS-pixel coordinates. drag takes source
        and destination targets; dragCoordinates takes from/to points and bounded movement
        steps. A one-shot dialog policy can accept or dismiss the next selected-page dialog,
        optionally supplying prompt text. It expires after ten seconds by default (maximum
        thirty seconds). Unexpected or expired dialogs dismiss immediately, so actions do not
        wait for a later RPC to resolve a modal.</p>

      <h3>Live viewing and human control</h3>
      <Code>{`const lease = browsers.acquireControl(session.id); // Default 30 seconds.
try {
  await browsers.execute(session.id, {
    op: "mouseClick", x: 200, y: 120,
  }, lease.token);
  const frame = await browsers.liveFrame(session.id);
  // Renew before expiry when keeping manual control:
  browsers.renewControl(session.id, lease.token);
} finally {
  browsers.releaseControl(session.id, lease.token);
}`}</Code>
      <p>Live view polls current PNG frames with timestamps; it is not a video stream.
        Busy frames are skipped and viewing does not extend idle lifetime. acquireControl
        grants an exclusive live lease for 1–120 seconds. While held, actions require its
        token, so automation cannot interleave browser input. control reports mode/expiry
        without exposing the token. Renew or release intentionally; expiry returns control
        to automation. Leases do not survive worker restart. Remote close honors the lease;
        direct lifecycle cleanup remains available to the worker.</p>

      <h3>Diagnostics and trace artifacts</h3>
      <Code>{`import type { BrowserArtifact } from "station-browser-use";
const diagnostics = await browsers.execute(session.id, { op: "diagnostics" });
// Console text is intentionally absent unless explicitly enabled for future events:
await browsers.execute(session.id, { op: "diagnostics", consoleText: true });
await browsers.execute(session.id, { op: "traceStart" });
// Perform the browser actions to investigate, then export:
const trace = await browsers.execute(session.id, { op: "traceStop" }) as BrowserArtifact;
const zip = await browsers.execute(session.id, {
  op: "downloadRead", artifactId: trace.id,
});
await browsers.execute(session.id, { op: "downloadDelete", artifactId: trace.id });`}</Code>
      <p>Diagnostics retain at most 200 console, network and dialog events. Default events
        omit console text, headers and bodies; URLs omit credentials, queries and fragments.
        Opt-in console text is bounded to 2 KiB per event and can still contain arbitrary
        application secrets. Turning it off purges retained console text; clear removes the
        ring. Dialog events contain type/action, not prompt contents or answers.</p>
      <p>Tracing is explicit and can contain sensitive screenshots, DOM and network/action
        data. ZIP files share the session&apos;s download artifact count/byte budget and expire
        on close. Traces abort and discard partial data at sixty seconds or their monitored
        raw-file budget. A failed/limited trace does not export a partial archive. Disk growth
        is sampled every fifty milliseconds; enforce a filesystem/container quota for a hard
        transient limit. Bun advertises these richer capabilities as unsupported.</p>

      <h3>Durable action history and explicit resume</h3>
      <Code>{`const browsers = new BrowserSessionManager(adapter, 4, {
  stateRootDir: "/data/browser-state",
  recordingRootDir: "/data/browser-recordings",
  auditLimit: 1000,
  // tenantId: "customer-a", // Required for already tenant-bound roots.
});
const checkpoint = await browsers.checkpoint(session.id);
await browsers.closeSession(session.id);
const replacement = await browsers.resumeCheckpoint(checkpoint.id);
const journal = browsers.audit();
await browsers.deleteCheckpoint(checkpoint.id);`}</Code>
      <p>stateRootDir enables an atomic single-owner journal separate from recordings and
        profiles. Action starts are persisted before execution and finishes afterward, with
        monotonic sequence numbers. Write failures stop action admission. A started entry
        without a finish has an unknown outcome; do not automatically replay the mutation.
        Default retention is the latest 1000 entries (maximum 10000), with an 8 MiB combined
        state limit. This bounded operational history is not an immutable compliance archive.
        Tenant identity is verified before recovery or retention can modify stored data.</p>
      <p>Checkpoints record backend, validated open options, selected page and sanitized
        HTTP(S) origin/path URLs; credentials, query strings and fragments are omitted.
        about:blank is also supported, with at most 64 checkpoints. Resume explicitly opens
        a new session on the same backend and navigates those URLs. It never runs automatically
        on startup. Persistent profiles can restore saved cookies after old ownership ends;
        they do not restore JavaScript memory, filled forms, pending requests or exact workflow
        progress. Re-navigation can itself have effects. Keep roots distinct, preserve their
        logical owner and use external fencing for failover.</p>

      <h3>Use the Headquarters dashboard</h3>
      <p>
        Sign in to Headquarters with its configured administrator account.
        <code> /sandboxes</code> provides worker selection, workspace creation,
        commands/output, cancellation, interactive terminals, supervised services, files and deletion. <code>/browser-use</code>
        provides separate browser session controls, navigation, interaction and
        screenshots, profiles, pages, semantic/frame targeting, live human control, inspection,
        diagnostics/traces, checkpoints and recording playback. Both use Headquarters as their public entry point.
      </p>
      <p>
        The admin-only <code>GET /api/v1/execution</code> endpoint discovers
        advertised workers and returns their identities, statuses, capabilities,
        backend names and availability. Capabilities are not guessed from labels.
        Discovery still requires selecting the exact owner; it does not schedule
        or migrate resources. The internal worker token stays between services.
      </p>

      <h3>Record screenshots and play them back</h3>
      <p>
        Select a live browser and choose Start recording. The worker captures a
        viewport PNG immediately and then every five seconds, even when the
        dashboard is closed. Busy browser operations skip a capture rather than
        queueing screenshots. This is a sequence of still frames, not a video or
        a complete audit of every action.
      </p>
      <p>
        Select a recording to play, pause or scrub through timestamped frames.
        Closing a browser stops its recording and keeps captured frames available.
        Defaults are 120 frames per recording, 16 retained recordings, and 64 MiB
        of PNG data across the worker manager. Reaching a limit stops capture and
        preserves existing frames. Delete recordings to release space. Recordings
        use memory by default. Configure recordingRootDir on persistent storage to survive
        worker replacement; recordingTtlMs defaults to seven days. A recovered recording
        is stopped: the platform does not reconstruct the old browser.
      </p>
      <Code>{`const recording = browsers.startRecording(session.id);
// Later, stop capture without closing the browser:
await browsers.stopRecording(recording.id);
const metadata = browsers.getRecording(recording.id);
const image = browsers.recordingFrame(recording.id, metadata.frames[0].id);
// image: { mimeType: "image/png", base64: string }
await browsers.deleteRecording(recording.id);`}</Code>
      <p>
        The same owner-routed admin endpoint supports recordingStart (session id),
        recordingStop, recording, recordingDelete (recording id), recordings (list),
        and recordingFrame (recording id and frameId). Metadata omits PNG payloads;
        playback fetches individual frames on demand.
      </p>

      <h3>Route through the exact owner</h3>
      <p>
        Configure three services: public Headquarters, private Sandbox worker and
        private Browser Use worker. All share Station&apos;s network ID and durable
        coordination adapters. Workers configure <code>execution.sandbox</code> or
        <code> execution.browser</code>; Headquarters needs the shared
        <code> execution.token</code>. This service token must contain at least
        32 characters and stays between trusted services. Public clients use a
        separate admin API key or authenticated admin session.
      </p>
      <Code>{`// Worker configuration fragment, merged with normal network/storage config:
execution: { token: process.env.STATION_EXECUTION_TOKEN!, sandbox: sandboxes }
// Browser worker: execution: { token, browser: browsers }
// Headquarters: execution: { token }

// All public calls are JSON POST requests:
/api/v1/stations/:stationId/execution/sandbox
/api/v1/stations/:stationId/execution/browser`}</Code>
      <Code>{`// Sandbox request bodies:
{ "method": "create" }
{ "method": "exec", "id": "WORKSPACE_ID", "command": "node --version", "timeoutMs": 30000 }
{ "method": "command", "id": "WORKSPACE_ID", "runId": "COMMAND_ID" }
{ "method": "cancel", "id": "WORKSPACE_ID", "runId": "COMMAND_ID" }
{ "method": "destroy", "id": "WORKSPACE_ID" }

// Browser request bodies:
{ "method": "open" }
{ "method": "execute", "id": "SESSION_ID", "command": { "op": "inspect" } }
{ "method": "liveFrame", "id": "SESSION_ID" }
{ "method": "controlAcquire", "id": "SESSION_ID", "ttlMs": 30000 }
{ "method": "checkpoint", "id": "SESSION_ID" }
{ "method": "action", "id": "SESSION_ID", "action": "navigate", "value": "https://example.com" }
{ "method": "action", "id": "SESSION_ID", "action": "screenshot" }
{ "method": "close", "id": "SESSION_ID" }`}</Code>
      <p>
        Successful responses wrap results in <code>data</code>. Both primitives also
        support <code>list</code>; Sandbox supports <code>get</code>. Keep the selected
        owner station ID with every resource ID. This API does not automatically place
        environments or persist distributed session ownership. Existing signal queue
        placement remains separate.
      </p>
      <p>
        Headquarters rejects offline, expired-lease and wrong-network owners,
        follows no redirects and never forwards the public API key to a worker.
        Draining blocks new work and browser actions while preserving Sandbox
        inspection/cancellation/deletion and browser list/close operations. It does not reroute a live resource to another station. Requests are
        capped at 128 KiB for ordinary operations; file uploads allow an 8 MiB JSON envelope
        with at most 4 MiB decoded content. Successful proxied responses are capped at 33 MiB including JSON/base64 overhead. A timeout can
        leave the operation&apos;s outcome unknown: inspect the owner before repeating
        create, open, exec or any other mutation.
      </p>

      <h3>Public tenant execution</h3>
      <p>Keep the dashboard and operator API restricted to your staff. Customer keys must
        have only the execution scope; Headquarters maps their verified key record IDs to
        tenant IDs. Each private worker is dedicated to one tenant. Both Headquarters and
        the worker check ownership, and tenant mode refuses host or unrestricted-network
        backends. Persisted owner bindings prevent reusing a data root for a different tenant.</p>
      <Code>{`// Headquarters: operator-owned configuration
execution: { token: serviceSecret, tenants: {
  apiKeyTenants: { "VERIFIED_KEY_RECORD_ID": "customer-a" },
} }
// Dedicated private worker, with an isolated/restricted adapter:
execution: { token: serviceSecret, tenantId: "customer-a", sandbox }
// Customer endpoints:
// GET /api/v1/tenant/execution
// POST /api/v1/tenant/stations/:stationId/execution/:primitive`}</Code>
      <p>ContainerBrowserAdapter from station-browser-use/container runs each Playwright
        session inside a separately constrained Linux container with an immutable image worker.
        Profile volumes and recordings retain their tenant ownership. Default networking is
        disabled. An operator-enforced named egress network is required for permitted internet
        browsing; a configuration flag alone does not install that policy.</p>
      <p>The included Linux deployment profile under <code>scripts/execution-container/enforced</code>
        provisions a dedicated internal Docker network, an HTTPS CONNECT proxy that connects
        to validated public IPv4 addresses, host firewall rules and XFS project quotas.
        Configure its verified network and proxy on ContainerBrowserAdapter, and use
        <code> profileStorageRoot</code> for quota-backed profiles. The immutable image includes
        a syscall guard that prevents browser descendants from changing quota metadata.</p>
      <p>This profile requires local rootful Linux Docker and XFS project-quota support.
        Direct internet connections, ordinary HTTP, UDP/QUIC, IPv6 and private destinations
        are denied. Both <code>stateRootDir</code> and <code>recordingRootDir</code> are required
        for public browser workers; place them under the same tenant quota tree. Verify the
        policy before starting workers and after host networking changes. Run
        <code> pnpm test:execution:policy</code> for fast proxy/verifier regressions and the
        supplied live harness for real network and disk-exhaustion checks.</p>
      <p>Read the <a href="https://github.com/porkytheblack/station/tree/main/scripts/execution-container">tenant deployment contract</a>
        for image builds, key provisioning, storage quotas, egress controls and rollout checks.
        These APIs supply execution boundaries; customer onboarding, billing, automatic
        provisioning and distributed failover remain responsibilities of the surrounding platform.</p>

      <h3>Persistence and service deployment</h3>
      <p>
        Use one process/replica per stable worker ID and one manager per Sandbox
        root. Mount persistent storage for workspace files and Station data; persist
        Headquarters&apos; data directory for API keys and session secrets. Shared
        Postgres coordinates Station membership, jobs and schedules; it does not
        store browser memory or workspace files. A service volume is not a shared
        multi-worker filesystem.
      </p>
      <p>
        On restart, leftover running command records become interrupted and are
        never automatically replayed. Saved files and configured profiles/recordings can survive; processes, shells
        and browser sessions do not. Supervisors must reap the old process tree
        before a replacement takes ownership. Workers need private reachable HTTP
        endpoints, packaged tools and browser libraries, and required outbound
        access. Disable sleeping when retaining live sessions.
      </p>
      <p>
        The example describes an ordinary service deployment contract. Linux primitive
        checks passed separately from the local SQLite/PostgreSQL dashboard tests;
        a Railway deployment remains unvalidated. Automatic placement,
        distributed ownership, migration, high availability, customer onboarding and
        billing require a platform layer beyond these execution primitives.
      </p>

      <h3>Exercise the full dashboard topology</h3>
      <Code>{`pnpm test:execution:dashboard`}</Code>
      <p>
        The integration harness targets the built Headquarters dashboard, real
        private execution workers, browser interaction/screenshots and a custom
        CLI installed from a dependency-free local package offline. Prepare the
        browser dependencies first; the command builds the dashboard. It covers
        worker restart and installed-tool persistence, command failures, cancellation,
        timeouts, workspace deletion, and closing browsers during pending actions.
        Passing this local test does not establish cloud deployment readiness.
      </p>

      <h3>Opt in to Bun signal and beacon children</h3>
      <Code>{`import { defineConfig } from "station-kit";
import { BunProcessRuntime } from "station-signal";

export default defineConfig({
  signalsDir: "./src/signals",
  beaconsDir: "./src/beacons",
  processRuntime: new BunProcessRuntime("bun"),
});`}</Code>
      <p>
        Node remains the default. <code>ProcessRuntime</code> selects signal/beacon
        bootstrap children and preserves JSON IPC; Bun loads TypeScript natively.
        The same option is available on <code>SignalRunner</code> and
        <code> BeaconRunner</code>. It does not switch the controller, Sandbox shell
        or browser adapter, and provides no isolation. Validate dependencies and
        representative workload behavior before rollout; benchmark actual Station
        jobs before claiming faster throughput or lower resource use.
      </p>
      <p>
        Read the <a href="https://github.com/porkytheblack/station/tree/main/packages/station-sandbox">Sandbox reference</a>,
        {" "}<a href="https://github.com/porkytheblack/station/tree/main/packages/station-browser-use">Browser Use reference</a>,
        {" "}<a href="https://github.com/porkytheblack/station/tree/main/examples/18-execution-network">three-service example</a>
        {" "}and <Link href="/docs/network">Station Network guide</Link> for the complete setup.
      </p>
    </>
  );
}
