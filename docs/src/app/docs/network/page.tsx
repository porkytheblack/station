import { Metadata } from "next";
import Link from "next/link";
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

      <h3>Roles and request flow</h3>
      <table className="api-table">
        <thead><tr><th>Role</th><th>Responsibility</th></tr></thead>
        <tbody>
          <tr><td><code>headquarters</code></td><td>API, dashboard, schedules, broadcasts, routing, and fleet inventory. It does not execute signals or beacons.</td></tr>
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

      <h3>Configure Headquarters</h3>
      <Code>{`import { defineConfig } from "station-kit";
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
