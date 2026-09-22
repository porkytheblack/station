import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = {
  title: "Docker Compose and persistent agents — Station",
  description: "Run the Station controller and dashboard in separate containers, manage sibling sandbox containers, and operate persistent agents such as Hermes.",
};

export default function DockerComposePage() {
  return <>
    <div className="eyebrow">Deployment guide</div>
    <h2 style={{ marginTop: 0 }}>Docker Compose and persistent agents</h2>
    <p>Station can run inside a container and manage separate sandbox containers through an operator-owned Docker engine. Compose starts the controller and dashboard; Station creates and supervises the workloads. A persistent agent such as Hermes runs inside its own sandbox with Bash, Git, Node, Python and a writable home volume.</p>
    <figure style={{ margin: "2rem 0" }}>
      {/* A static SVG keeps the architecture legible and downloadable without JavaScript. */}
      <img src="/diagrams/station-compose.svg" width="960" height="500" style={{ width: "100%", height: "auto", borderRadius: 12 }} alt="Compose starts separate dashboard and Station controller containers. Only the controller accesses the host Docker engine, which runs a sibling Hermes sandbox. Controller state and the agent home use separate persistent storage." />
      <figcaption>One engine, separate containers. The agent never receives the Docker socket.</figcaption>
    </figure>

    <h3>What runs where</h3>
    <table className="api-table"><thead><tr><th>Component</th><th>Responsibility</th><th>Access</th></tr></thead><tbody>
      <tr><td>Compose</td><td>Starts and restarts the Station controller and dashboard.</td><td>Operator deployment configuration.</td></tr>
      <tr><td>Station controller</td><td>Owns sandbox lifecycle, terminals, files and service supervision.</td><td>Docker socket and private controller state.</td></tr>
      <tr><td>Dashboard</td><td>Authenticated web client and proxy to Station.</td><td>No Docker socket, credentials file or workload volume.</td></tr>
      <tr><td>Hermes sandbox</td><td>Runs the gateway, agent tools and interactive shells.</td><td>Its own persistent home; configured outbound network access.</td></tr>
    </tbody></table>
    <p>This uses sibling containers on the same engine. It does not start a second Docker daemon inside Station. Compose does not adopt the sandbox as one of its services: Station owns its lifecycle, and its Docker labels and named volume remain after Compose is stopped.</p>

    <h3>Run the example</h3>
    <p>The <a href="https://github.com/porkytheblack/station/tree/main/examples/20-hermes-sandbox">Hermes sandbox example</a> contains the application image, separate controller/dashboard build targets, Compose configuration, provisioning scripts and operational runbook. Use the checkout until the corresponding packages are published. The detailed runbook explains how to build the pinned Hermes image and initialize private settings with a reviewed seccomp profile.</p>
    <Code>{`# After building the Hermes image and initializing private settings:
docker compose -f examples/20-hermes-sandbox/compose.yaml build
docker compose -f examples/20-hermes-sandbox/compose.yaml up -d --wait

# Provision through Station; pass file paths, never credential values.
node examples/20-hermes-sandbox/provision.mjs \\
  /private/openrouter-key.txt /private/telegram-token.txt TELEGRAM_USER_ID

docker compose -f examples/20-hermes-sandbox/compose.yaml ps`}</Code>
    <p>Open <code>http://127.0.0.1:5801</code>, sign in with the generated private credentials, and choose <strong>Sandboxes → worker → workspace</strong>. Commands, Terminal, Services and Files are separate pages. Start long-running agents through Services; ordinary Commands have a timeout.</p>
    <p>When moving an existing local setup to Compose, back up first and stop its local controller before mounting the same state. Two controllers must never own one workspace root. The example retains the existing volume, sandbox identity and credentials. Its container entrypoint uses an exclusive filesystem lock and a stable controller identity to handle stale PID records after a container restart.</p>

    <h3>Networking and boundaries</h3>
    <p>The dashboard has its own network namespace and reaches the authenticated daemon over verified HTTPS on the private Compose network. It mounts only the public trust certificate; the controller keeps the private key. This lets the controller restart without stranding the dashboard in an old network namespace. Only loopback host ports are published. The sandbox uses a separate Docker network namespace: processes inside it can communicate on their own <code>127.0.0.1</code>.</p>
    <p>Bridge networking permits outbound API calls, but it is not an egress allowlist or a public-tenant network policy. The Docker socket grants powerful host-level control. Mount it only into the trusted controller; never into an agent sandbox or dashboard. Public tenants need dedicated workers, tenant-scoped authorization, independently enforced network/storage limits and production-host validation. Read the <Link href="/docs/execution">execution guide</Link> for those requirements.</p>
    <p>For one fixed trusted agent, another option is a Station host-process adapter running inside an outer container. It needs no Docker socket inside, but all workspaces in that service share that container&apos;s isolation boundary. This example deliberately uses the container adapter and separate workload containers.</p>

    <h3>Persistence and recovery</h3>
    <table className="api-table"><thead><tr><th>Event</th><th>Expected behavior</th></tr></thead><tbody>
      <tr><td>Close the dashboard tab</td><td>Agent service and shell keep running.</td></tr>
      <tr><td>Hermes exits or crashes</td><td>Station applies the configured bounded service restart policy.</td></tr>
      <tr><td>Controller restarts</td><td>Station reconciles its owned container and restarts desired services. Existing interactive shells are interrupted; files persist.</td></tr>
      <tr><td>Docker is missing at startup</td><td>The container adapter refuses startup. It never falls back to host execution.</td></tr>
      <tr><td>Engine connection is lost</td><td>Container operations fail. A connection loss does not prove the workload stopped; reconcile before retrying uncertain mutations.</td></tr>
      <tr><td>Docker Desktop or host stops</td><td>Execution stops. Retained volumes survive unless deleted. Restore the engine and verify controller and service recovery.</td></tr>
      <tr><td>Command timeout / forced cancellation</td><td>Containment can stop the entire workspace, including sibling services. Restart the desired service explicitly.</td></tr>
    </tbody></table>
    <p>Compose&apos;s restart policy restarts exited containers, not merely unhealthy ones. It does not make a sleeping laptop an always-on host. The example&apos;s API health check confirms controller responsiveness, not Telegram delivery or model-provider availability. Monitor those separately.</p>
    <p>The Hermes home, user installs and conversations live on its named volume. Controller metadata lives in the private state mount. Back up both consistently while Station is stopped, protect backups as credentials, and test restoration. <code>docker compose down</code> is not a sandbox deletion command. Avoid volume-prune commands on an execution host.</p>
    <p>The Docker and Podman adapters require an available compatible Linux engine with enforceable resource limits and seccomp. Backend selection is explicit; Podman is not an automatic failover target for existing Docker volumes.</p>

    <h3>What the local test covers</h3>
    <p>The example has exercised a real model-driven shell task, interactive dashboard access, custom installation, communication between sandbox-local processes, gateway crash recovery, persistent files and an offline backup. The deployment runbook includes controller crash recovery, exclusive ownership and missing-engine checks. The internal TLS certificate lasts one year; renew it and recreate both services before expiry as described in the example runbook. These checks do not establish multi-tenant isolation or high availability on an intended production Linux host.</p>
  </>;
}
