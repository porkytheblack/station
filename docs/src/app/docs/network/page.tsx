import { Metadata } from "next";
import Link from "next/link";
import { ArchitectureFigure } from "../../components/ArchitectureFigure";
import { Code } from "../../components/Code";

export const metadata: Metadata = { title: "Station Networks — Station" };

export default function NetworkPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Station Networks</h2>
      <p>
        A <strong>Station Network</strong> scales Station across processes or
        machines. One logical <strong>Headquarters</strong> accepts requests,
        presents fleet-wide state, and reconciles schedules. Execution stations
        advertise capacity and definitions, then atomically claim work from the
        shared adapters.
      </p>

      <ArchitectureFigure title="Queued work: any eligible worker can claim it" nodes={[
        { label: "Public entry point", title: "Headquarters", detail: "Authenticates a request, validates it and enqueues the run." },
        { label: "Shared durable state", title: "Queue + leases", detail: "Atomic claims assign one attempt to one owner. State is shared across the fleet.", accent: true },
        { label: "Private execution", title: "Eligible worker", detail: "Checks definitions, placement and capacity, then executes the claimed run." },
      ]} caption="Workers claim queued work; Headquarters does not push every job directly. Retries and lease recovery can repeat work, so external effects still need idempotency." />

      <h3>Roles and request flow</h3>
      <table className="api-table">
        <thead><tr><th>Role</th><th>Responsibility</th></tr></thead>
        <tbody>
          <tr><td><code>headquarters</code></td><td>API, schedules, broadcasts, routing and fleet inventory for the separate dashboard. It does not execute signals or beacons.</td></tr>
          <tr><td><code>station</code></td><td>Advertises local definitions and executes eligible signal runs and beacon instances.</td></tr>
          <tr><td><code>standalone</code></td><td>Backwards-compatible single-node mode that performs both roles.</td></tr>
        </tbody>
      </table>
      <p>
        Headquarters enqueues a run once. Stations race to claim it in the
        shared queue; the adapter&apos;s atomic pending-to-running transition chooses
        exactly one owner. If that owner disappears, its lease expires and the
        run is recovered. Fencing tokens prevent the old owner from later
        completing the recovered attempt.
      </p>

      <p>
        Specialized stations can also own <Link href="/docs/execution">Sandbox
        workspaces and Browser Use sessions</Link>. Their initial execution API
        routes requests to an explicitly selected owner through Headquarters;
        it does not use signal queue placement or migrate live sessions.
      </p>

      <ArchitectureFigure title="Live environments: return to their owning worker" nodes={[
        { label: "Client or agent", title: "Workspace / session ID", detail: "Requests another command, browser action or screenshot." },
        { label: "Authenticated routing", title: "Headquarters", detail: "Resolves the authorized worker target; tenant grants are operator-configured.", accent: true },
        { label: "Existing owner", title: "Sandbox or browser", detail: "The selected worker operates its retained workspace or live browser session." },
      ]} caption="Session routing is not queue placement. A different worker cannot automatically pick up an open terminal or browser just because both workers share a database." />
      <p>For example, keep CPU build tools on one Station and browser sessions on another. Both can be private services behind Headquarters. A signal can invoke their APIs, but application code must retain resource IDs and handle interrupted or unknown outcomes. Read the <Link href="/docs/sandboxes">Sandbox</Link> and <Link href="/docs/browser-use">Browser Use</Link> lifecycle guides before planning recovery.</p>
      <p>A Station Network coordinates work; it does not provision a VPN or Docker-style network. Workers need access to shared adapters and Headquarters needs a reachable, authenticated endpoint for proxied execution. Configure DNS, TLS, firewalls and ingress in the deployment. Keep private worker credentials and tenant assignments in operator configuration; a heartbeat is discovery data, not permission to act as a tenant.</p>

      <h3>Configure Headquarters</h3>
      <Code>{`import { defineConfig } from "station-daemon";
import { PostgresAdapter } from "station-adapter-postgres";
import { StationNetworkPostgresAdapter } from "station-adapter-postgres/network";

const connectionString = process.env.DATABASE_URL!;

export default defineConfig({
  role: "headquarters",
  adapter: new PostgresAdapter({ connectionString }),
  network: {
    id: "production",
    stationId: "hq-1",
    name: "Production HQ",
    adapter: new StationNetworkPostgresAdapter({ connectionString }),
  },
  signalsDir: "./signals", // catalog + validation; never executed here
  scheduleAdapter,
  beaconAdapter,
});`}</Code>

      <h3>Configure an execution station</h3>
      <Code>{`export default defineConfig({
  role: "station",
  adapter: new PostgresAdapter({ connectionString }), // same queue
  beaconAdapter,                                      // same beacon state
  network: {
    id: "production",
    stationId: process.env.STATION_ID!,
    name: "Kenya GPU worker",
    adapter: new StationNetworkPostgresAdapter({ connectionString }),
    labels: { region: "ke", gpu: "true" },
    endpoint: "https://worker-ke.internal.example",
  },
  signalsDir: "./signals",
  beaconsDir: "./beacons",
  runner: { maxConcurrent: 12 },
});`}</Code>
      <p>
        Use the matching <code>/network</code> export for SQLite, PostgreSQL,
        MySQL, or Redis. Every process must use the same durable queue and
        network backends. Share beacon state on nodes that coordinate beacons,
        and share schedule state across Headquarters replicas. The memory
        implementations are only for standalone mode and tests. SQLite requires
        a shared filesystem; use PostgreSQL, MySQL, or Redis across machines.
      </p>

      <h3>Capacity, placement, and draining</h3>
      <Code>{`export const render = signal("render")
  .input(RenderInput)
  .concurrency({ station: 4, network: 20 })
  .placement({ labels: { gpu: "true", region: "ke" } })
  .run(async (input) => { /* ... */ });

export const gateway = beacon("gateway")
  .placement({ labels: { region: "ke" } })
  .run(async (ctx) => {
    const server = await listen();
    ctx.expose({ protocol: "http", port: server.port, path: "/gateway" });
    ctx.ready();
    await ctx.untilStopped();
  });`}</Code>
      <p>
        Per-station concurrency limits local process pressure. Network
        concurrency uses shared controller leases and is enforced across the
        fleet. Placement labels require an exact match. Marking a station
        <code>draining</code> through the Stations dashboard or v1 API stops new
        claims while current work finishes.
      </p>

      <h3>Schedules and exact times</h3>
      <p>
        Runtime schedules support five-field cron plus an IANA timezone. The
        stored <code>nextRunAt</code> is an absolute timestamp and occurrences
        advance from the prior planned time, so polling latency does not create
        cumulative drift. Atomic occurrence claims prevent duplicate fires
        across control-plane processes. As with OS cron, the timestamp is when
        work becomes eligible; actual handler start can be delayed by polling,
        queue pressure, or unavailable capacity. See <Link href="/docs/schedules">Schedules</Link>.
      </p>

      <h3>Beacon services</h3>
      <p>
        A networked beacon instance is protected by a single-owner lease.
        Calling <code>ctx.expose()</code> records its station, protocol, port,
        and base path. Headquarters proxies HTTP traffic at
        <code>/api/v1/beacons/:name/instances/:id/proxy/*</code>. The owning
        station must advertise a reachable <code>network.endpoint</code>;
        private/NAT-only stations need an operator-provided tunnel endpoint. The
        proxy requires a <code>trigger</code> or <code>admin</code> scope, removes
        the caller&apos;s authorization and cookie headers before forwarding, and
        does not proxy WebSocket upgrades. Protect direct station endpoints and
        do not treat the injected <code>x-station-*</code> headers as proof of
        identity on a publicly reachable service.
      </p>

      <h3>What happens when a worker disappears?</h3>
      <table className="api-table"><thead><tr><th>Resource</th><th>Recovery model</th></tr></thead><tbody>
        <tr><td>Signal attempt</td><td>Lease expiry makes recovery possible. Fencing rejects stale completion; it cannot undo an external effect already performed.</td></tr>
        <tr><td>Beacon process</td><td>Shared intent and ownership leases coordinate a replacement. New process memory starts fresh.</td></tr>
        <tr><td>Sandbox workspace</td><td>Files may persist on its owner. Restart and service recovery depend on the adapter; there is no automatic cross-worker workspace migration.</td></tr>
        <tr><td>Browser session</td><td>The live browser is interrupted. Retained profiles, recordings and explicit checkpoints can help reopen on a compatible owner.</td></tr>
      </tbody></table>
      <p>Draining stops new queued claims. Also inspect worker-owned shells, services and browser sessions before maintenance; an empty signal queue does not prove the worker has no live environments.</p>

      <h3>Production checklist</h3>
      <ul>
        <li>Give every process a stable, unique <code>stationId</code> and the same <code>network.id</code>.</li>
        <li>Keep the lease duration above normal database, network, and event-loop jitter.</li>
        <li>Drain a station before maintenance; wait for active work before stopping it.</li>
        <li>Test at least two workers against the production backend and assert single ownership, placement, both concurrency levels, schedule deduplication, and expired-lease recovery.</li>
        <li>Measure the production workload. A local SQLite benchmark is useful for regression detection, not fleet sizing.</li>
      </ul>
    </>
  );
}
