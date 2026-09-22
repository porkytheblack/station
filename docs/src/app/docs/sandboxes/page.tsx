import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";
import { ArchitectureFigure } from "../../components/ArchitectureFigure";

export const metadata: Metadata = {
  title: "Sandboxes: files, shells and persistent agents",
  description: "Understand Station sandbox ownership, Docker and host adapters, custom installs, Git, terminals, supervised services, networking and recovery.",
};

export default function SandboxesPage() {
  return <>
    <div className="eyebrow">Execution guide</div>
    <h2 style={{ marginTop: 0 }}>Sandboxes</h2>
    <p>A sandbox gives an agent a working directory, files, real shell commands and optional interactive terminals. It can clone a repository, install a tool, edit code or keep an agent server running. <code>station-sandbox</code> manages that environment on a particular worker; it does not emulate Unix or automatically move a running process to another machine.</p>
    <ArchitectureFigure title="Inside a container-backed sandbox" nodes={[
      { label: "Operator supplies", title: "Tools image", detail: "A Linux image with Node, Bash and setsid. Add Git, Python or your agent runtime here." },
      { label: "Station owns", title: "Workspace container", detail: "Commands, shells and services share this workspace and its localhost network.", accent: true },
      { label: "Docker retains", title: "Home volume", detail: "Repository, user installs and application data under /home/node survive container replacement." },
    ]} caption="The controller stores workspace metadata separately. Preserve both controller state and the home volume; neither one is a running-process snapshot.">
      <div className="architecture-band"><strong>Trust boundary:</strong> only the controller can access the container engine. Agent commands never receive the Docker socket.</div>
    </ArchitectureFigure>

    <h3>Choose the boundary before running code</h3>
    <table className="api-table"><thead><tr><th>Adapter</th><th>What it provides</th><th>Use it for</th></tr></thead><tbody>
      <tr><td><code>HostSandboxAdapter</code></td><td>Separate workspace and home directories; processes run as the worker user.</td><td>Trusted local or internal code. A directory is not a security boundary.</td></tr>
      <tr><td><code>ContainerSandboxAdapter</code></td><td>One nonroot Docker or Podman container per workspace, persistent home, read-only root, resource limits and enforced seccomp.</td><td>Work that needs a container boundary, with operator-managed network policy and disk quotas.</td></tr>
    </tbody></table>
    <p>Install and configure tools on the host for the host adapter, or build them into the tools image for the container adapter. Container startup fails when its engine or required policy is unavailable; Station never silently switches to host execution. A container shares the host kernel. Public tenants also need the authorization, private-worker and egress controls in the <Link href="/docs/execution">execution reference</Link>.</p>

    <h3>Create a workspace and run a command</h3>
    <p>This operator-side example requires a prebuilt image and a reviewed seccomp policy. The image digest is a placeholder. Start with no external network access, then configure an enforced network policy if the workload needs downloads or model APIs.</p>
    <Code>{`import { ContainerSandboxAdapter } from "station-sandbox/container";

const sandboxes = new ContainerSandboxAdapter({
  rootDir: "/data/sandbox-metadata",
  image: "registry.example/tools@sha256:YOUR_VERIFIED_DIGEST",
  seccompProfile: "/etc/station/seccomp.json",
  network: "none",
  cpus: 1, memoryMb: 1024, pidsLimit: 128,
});
await sandboxes.ready();
const workspace = await sandboxes.create();
const run = await sandboxes.exec(workspace.id, {
  command: "node --version && pwd",
  timeoutMs: 10_000,
});
// exec returns a run handle. Read command() until status is terminal.
const current = await sandboxes.command(workspace.id, run.id);
console.log(current.status, current.stdout);`}</Code>
    <p>Commands have bounded runtime and output. Inspect <code>status</code>, <code>exitCode</code> and <code>truncated</code>; receiving a run ID does not mean the command succeeded. Retain the workspace ID in trusted application state so later requests reach the same worker and workspace.</p>

    <h3>Use the right surface for the work</h3>
    <table className="api-table"><thead><tr><th>Dashboard page</th><th>Use</th><th>Lifetime</th></tr></thead><tbody>
      <tr><td>Commands</td><td>A build, test run, clone or installation.</td><td>One bounded execution with output and exit status.</td></tr>
      <tr><td>Terminal</td><td>An interactive Bash session, editor or agent CLI.</td><td>Reconnect while its worker and process live. Requires enabled PTY support.</td></tr>
      <tr><td>Services</td><td>An agent gateway, OpenCode-style server or application.</td><td>Foreground process with explicit, bounded restart policy.</td></tr>
      <tr><td>Files</td><td>Browse, read, edit, upload and remove workspace files.</td><td>Files persist independently of the dashboard tab.</td></tr>
    </tbody></table>
    <p>Open <strong>Sandboxes → worker → workspace</strong> in the <Link href="/docs/dashboard">dashboard</Link>. Closing the browser tab does not stop a service. Force-closing a terminal, cancelling a command or hitting a command timeout can stop the entire container to contain descendants, interrupting sibling services. Restart affected services explicitly afterward.</p>
    <Code>{`const service = await sandboxes.startService(workspace.id, {
  name: "agent-gateway",
  command: "node server.js", // Foreground: do not append & or daemonize.
  restart: { policy: "on-failure", maxRestarts: 5, delayMs: 1000 },
});
// Inspect attempts and output through service()/the Services page.
// Stop deliberately with stopService(workspace.id, service.id).`}</Code>

    <h3>Install tools and work with Git</h3>
    <p>Use the image for reproducible shared tools and a workspace-local install for project dependencies. In the container adapter, <code>HOME</code> is <code>/home/node</code>, the default working directory is <code>/home/node/workspace</code>, and npm&apos;s user prefix is <code>/home/node/.local</code>. That prefix is on the command path. Installs under this home persist; changes to temporary files do not.</p>
    <Code>{`# Inside a sandbox with Git and permitted outbound network access:
git clone --depth 1 https://github.com/OWNER/REPOSITORY.git app
cd app
# Review its install scripts before running them.
npm ci
# Edit files in the dashboard or terminal.
git diff
git status --short

# For a custom CLI, pin an approved package version:
npm install --global YOUR_CLI@EXACT_VERSION`}</Code>
    <p>A GitHub App credential can authorize one repository without giving the agent your personal account. Mint a short-lived installation token outside the sandbox, grant only the required repository permissions, and deliver it through protected runtime configuration or a credential helper. Do not embed tokens in clone URLs or command text. A local commit needs no remote permission; pushing and opening a pull request require the corresponding grants.</p>

    <h3>Networking inside the workspace</h3>
    <p>Processes in one sandbox can talk over <code>127.0.0.1</code>: an agent can call its own test server or local API. Separate sandboxes have separate network namespaces. Station does not automatically create Compose-style service discovery, publish arbitrary ports, or proxy every sandbox service. Cross-workspace networking and external ingress require an operator-provided design.</p>
    <p><code>network: "none"</code> still permits sandbox-local loopback. Bridge networking enables outbound access, but does not itself restrict access to private networks, metadata endpoints or other tenants. The <code>networkRestricted</code> setting describes an independently enforced policy; it does not install a firewall.</p>

    <h3>What survives a restart?</h3>
    <table className="api-table"><thead><tr><th>State</th><th>Recovery</th></tr></thead><tbody>
      <tr><td>Repository, user installs, agent state</td><td>Retained when saved in the persistent home volume. Back it up with controller metadata.</td></tr>
      <tr><td>Shell and process memory</td><td>Interrupted. A new process starts from files, not from the previous instruction.</td></tr>
      <tr><td>Container service intent</td><td>Controller recovery reconciles owned containers and relaunches desired services. It does not resume the old process.</td></tr>
      <tr><td>Host adapter services</td><td>Interrupted on worker restart; inspect state and restart explicitly.</td></tr>
      <tr><td>Temporary files</td><td>Not durable. Keep application state out of temporary storage.</td></tr>
    </tbody></table>
    <p>Do not point two live controllers at the same metadata root. Local ownership locks are not distributed failover. Disk quotas, backups, host availability and monitoring remain deployment responsibilities.</p>
    <div className="guide-paths">
      <Link href="/docs/docker-compose"><strong>Run a persistent agent →</strong><span>Compose, a separate controller and dashboard, and a real Hermes sandbox.</span></Link>
      <Link href="/docs/execution"><strong>Configure execution access →</strong><span>Worker configuration, tenant routing, API operations and enforcement requirements.</span></Link>
    </div>
  </>;
}
