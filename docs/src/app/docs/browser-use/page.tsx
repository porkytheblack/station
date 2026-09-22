import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";
import { ArchitectureFigure } from "../../components/ArchitectureFigure";

export const metadata: Metadata = {
  title: "Browser Use: agent sessions, profiles and recordings",
  description: "Give agents browser tools, understand worker-owned sessions and persistent profiles, capture playback, and choose local, container or hosted browser adapters.",
};

export default function BrowserUsePage() {
  return <>
    <div className="eyebrow">Execution guide</div>
    <h2 style={{ marginTop: 0 }}>Browser Use</h2>
    <p>Browser Use gives an agent a browser it can observe and control: navigate, inspect elements, fill forms, manage tabs and capture screenshots. A worker owns each live session. The dashboard lets you inspect its activity, review recordings and temporarily take human control.</p>
    <p>This is <code>station-browser-use</code>. The separate <Link href="/docs/browser">browser runtime</Link> runs Station jobs inside a Web Worker or service worker. A Browser Use session also does not require a <Link href="/docs/sandboxes">sandbox workspace</Link>.</p>
    <ArchitectureFigure title="The agent observes, acts, then observes again" nodes={[
      { label: "Agent application", title: "Scoped tools", detail: "The host grants a worker, sessions and profiles. The model chooses an allowed action." },
      { label: "Station worker", title: "Session manager", detail: "Routes the action to its owning browser and enforces capacity and control leases.", accent: true },
      { label: "Browser adapter", title: "Page + context", detail: "Runs the action and returns page data or screenshot pixels for the next decision." },
    ]} caption="Feed observations back to the agent after each meaningful action. Website content is untrusted input, not new instructions for the agent.">
      <div className="architecture-band"><strong>Human takeover:</strong> an exclusive, expiring control lease pauses competing automation. Releasing it returns control to the agent.</div>
    </ArchitectureFigure>

    <h3>Choose where the browser runs</h3>
    <table className="api-table"><thead><tr><th>Backend</th><th>Execution</th><th>Important boundary</th></tr></thead><tbody>
      <tr><td>Playwright</td><td>Local Chromium with structured actions, profiles, files, diagnostics and traces.</td><td>Trusted host workload; browser processes do not isolate tenants from the worker OS.</td></tr>
      <tr><td>Container Playwright</td><td>One Docker or Podman container per session; retained profile storage when configured.</td><td>Operator-managed engine, image, seccomp, egress policy and storage quotas.</td></tr>
      <tr><td>Bun WebView</td><td>Owned Bun subprocess using the supported WebView runtime.</td><td>Smaller capability set. Check capabilities before using advanced browser commands.</td></tr>
      <tr><td>Browserbase / Steel</td><td>Provider-managed session controlled over Playwright CDP.</td><td>Provider credentials, profile grants, session limits and cleanup stay with the operator.</td></tr>
    </tbody></table>
    <p>Adapters expose capabilities; an application must check them instead of assuming every backend supports every command. Hosted proxies and challenge detection can help diagnose access failures, but do not guarantee CAPTCHA-free access. Remote downloads and trace exports are currently disabled pending provider-specific artifact handling. See the <a href="https://github.com/porkytheblack/station/blob/main/packages/station-browser-use/REMOTE.md">remote browser guide</a>.</p>

    <h3>Give an agent browser tools</h3>
    <p>Create one toolset per authorized workflow. Bind connection details and grants in your application; the model must not choose credentials or tenant identity.</p>
    <Code>{`import { BrowserUseClient, createBrowserAgentTools } from "station-browser-use/agent";

const tools = createBrowserAgentTools({
  client: new BrowserUseClient({
    baseUrl: "https://station.example.com",
    stationId: "tenant-browser-worker",
    apiKey: process.env.STATION_EXECUTION_KEY!,
  }),
  maxSessions: 1,
  profileIds: ["research"], // Explicit grant; omit for ephemeral sessions.
});
try {
  // Mount name, description and inputSchema in your agent framework.
  // Call tool.execute(input, { signal }) for each selected tool.
  // Send result.images through the model's native image channel.
  await runYourAgent(tools); // Your application's agent loop.
} finally {
  await tools.close();
}`}</Code>
    <p>The tools cover open, sessions, navigate, observe, interact, screenshot, checkpoint, resume and close. Structured interactions include semantic locators, frames, page selection, pointer input and file transfer where supported. Screenshots are image results: stringifying base64 into text does not give the model vision. The <a href="https://github.com/porkytheblack/station/tree/main/examples/19-foundry-browser">Foundry example</a> demonstrates that bridge.</p>
    <p>Prefer roles, labels and test IDs to fragile CSS paths. Inspect again after navigation or a page update, because old element positions can be stale. Confirm the result of a consequential action before proceeding. A lost response does not prove a click or upload failed; reconcile the session instead of blindly repeating it.</p>

    <h3>Session, profile and checkpoint are different</h3>
    <ArchitectureFigure title="Persist the account; recreate the browser" nodes={[
      { label: "Open", title: "Granted profile", detail: "Load retained cookies and browser storage into one exclusively owned session." },
      { label: "Work", title: "Live session", detail: "Tabs, JavaScript, requests and control leases belong to the running browser.", accent: true },
      { label: "Close + reopen", title: "New session", detail: "Reuse persisted profile data after release. Authentication may still need renewal." },
    ]} caption="A checkpoint records sanitized page URLs and open options. Resuming creates a new session; it cannot restore live DOM, memory, forms or pending requests." />
    <p>Keep one profile per tenant and account. A browser closing is not an account logout. Profiles contain authentication material and must be protected like credentials. With Steel, wait for profile release and the provider&apos;s READY state before reuse. Browser session lifetime and account lifetime are separate.</p>
    <p>WhatsApp QR linking through Steel and the dashboard was exercised locally. That does not establish reliable authenticated profile reuse or verified TikTok/Instagram automation. Uploading a file is also separate from publishing it. Upload commands currently accept at most 16 files and 4 MiB of decoded data; large media workflows need additional artifact handling.</p>

    <h3>Capture a frame every five seconds</h3>
    <p>Configure recording storage and limits on the worker, then start recording explicitly. This example assumes an already configured adapter.</p>
    <Code>{`import { BrowserSessionManager } from "station-browser-use";

const browsers = new BrowserSessionManager(adapter, 4, {
  recordingRootDir: "/data/browser-recordings",
  stateRootDir: "/data/browser-state",
  intervalMs: 5_000,
  maxFrames: 120,
  maxTotalBytes: 64 * 1024 * 1024,
});
const session = await browsers.open({ profileId: "research" });
const recording = browsers.startRecording(session.id);
// ...your browser actions...
await browsers.stopRecording(recording.id);
await browsers.closeSession(session.id);
// Review saved frames in the dashboard's Recordings page.`}</Code>
    <p>Recordings are timestamped PNG frames, not continuous video. Busy actions can skip captures, storage or frame limits stop recording, and capture ticks do not keep an idle session alive. At a five-second cadence, 120 frames represent roughly ten minutes if no capture is skipped. Configured disk storage preserves captured frames across worker restarts; it does not keep the browser running.</p>

    <h3>Operate from the dashboard</h3>
    <p>Open <strong>Browser Use → worker → session</strong>. Use its action controls to inspect or operate the selected page, <strong>Live</strong> for periodic screenshots and human takeover, and <strong>Recordings</strong> for playback. The page is an observation and control surface; closing the dashboard does not close the remote browser.</p>
    <table className="api-table"><thead><tr><th>Keep</th><th>Where it lives</th><th>What it does not restore</th></tr></thead><tbody>
      <tr><td>Profile</td><td>Configured local/container storage or a granted provider profile.</td><td>Guaranteed login validity, running scripts or all open tabs.</td></tr>
      <tr><td>Recording</td><td>Worker recording root, with retention and byte limits.</td><td>The session itself, or activity between captured frames.</td></tr>
      <tr><td>Checkpoint and audit</td><td>Separate configured state root, bounded by retention limits.</td><td>Exact application state or automatic replay of unfinished mutations.</td></tr>
      <tr><td>Download / trace artifact</td><td>Session-scoped artifact store where supported.</td><td>Durability after session closure. Export needed artifacts beforehand.</td></tr>
    </tbody></table>
    <p>Keep profile, recording and state roots separate and assign them to one logical worker. Live sessions remain on their owner; shared queue storage does not migrate them. Worker restarts interrupt browsers. Explicitly reopen or resume after cleanup, and inspect unknown action outcomes before retrying.</p>
    <div className="guide-paths">
      <Link href="/docs/execution"><strong>Configure the worker →</strong><span>Adapter setup, tenant authorization, API reference and deployment boundaries.</span></Link>
      <Link href="/docs/network"><strong>Route through Headquarters →</strong><span>Understand session ownership and how it differs from queued jobs.</span></Link>
    </div>
  </>;
}
