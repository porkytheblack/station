import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../components/Code";

export const metadata: Metadata = { title: "Dashboard Guide — Station" };

const shotStyle = { width: "100%", borderRadius: "4px", border: "1px solid var(--concrete-dark)", margin: "1rem 0" };

export default function DashboardPage() {
  return (
    <>
      <div className="eyebrow">Guide</div>
      <h2 style={{ marginTop: 0 }}>Station dashboard</h2>
      <p>
        The dashboard is the control surface included with <code>station-kit</code>.
        In standalone mode it shows one process. In a Station Network it gives
        Headquarters one fleet-wide view of queued work, workers, schedules,
        beacons, broadcasts, and environment configuration.
      </p>

      <div className="info-box"><p>
        <strong>New here?</strong> Follow the four-minute setup below, then use
        Overview → Signals → Run detail. <strong>Operating a fleet?</strong> Start
        with Stations, Schedules, Environment, and the v1 API panels shown at the
        bottom of each screen.
      </p></div>

      <hr className="divider" />
      <h3>Quick start</h3>
      <Code>{`pnpm add station-kit station-adapter-sqlite`}</Code>
      <Code>{`// station.config.ts
import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { BeaconSqliteAdapter } from "station-adapter-sqlite/beacon";
import { ScheduleSqliteAdapter } from "station-adapter-sqlite/schedules";
import { EnvSqliteAdapter } from "station-adapter-sqlite/env";

const dbPath = "./station.db";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  beaconsDir: "./beacons",
  adapter: new SqliteAdapter({ dbPath }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath }),
  beaconAdapter: new BeaconSqliteAdapter({ dbPath }),
  scheduleAdapter: new ScheduleSqliteAdapter({ dbPath }),
  envStorage: new EnvSqliteAdapter({ dbPath }),
  auth: { username: "admin", password: process.env.STATION_PASSWORD! },
});`}</Code>
      <Code>{`STATION_PASSWORD=change-me npx station`}</Code>
      <p>
        Open <code>http://localhost:4400</code>. The configured Station port is
        the single public address for both UI and API; Station handles the
        dashboard process internally.
      </p>
      <div className="warn-box"><p>
        Authentication is optional for localhost, but do not expose an
        unauthenticated dashboard. In production, use environment-backed
        credentials, TLS, and scoped API keys for automation.
      </p></div>

      <img src="/screenshots/login.png" alt="Station login with username and password fields" style={shotStyle} />

      <hr className="divider" />
      <h3>A map of the dashboard</h3>
      <table className="api-table">
        <thead><tr><th>Screen</th><th>Use it for</th></tr></thead>
        <tbody>
          <tr><td><strong>Overview</strong></td><td>Fleet-wide status totals, recent failures, and live lifecycle events.</td></tr>
          <tr><td><strong>Signals</strong></td><td>Discover definitions, validate input, trigger work, and inspect run history.</td></tr>
          <tr><td><strong>Broadcasts</strong></td><td>Trigger and observe multi-signal DAG workflows.</td></tr>
          <tr><td><strong>Beacons</strong></td><td>Supervise long-running processes and their runtime instances.</td></tr>
          <tr><td><strong>Schedules</strong></td><td>Create, pause, preview, and inspect interval or timezone-aware cron schedules.</td></tr>
          <tr><td><strong>Stations</strong></td><td>See network membership, capacity, definitions, heartbeats, and drain state.</td></tr>
          <tr><td><strong>Environment</strong></td><td>Manage global or target-scoped runtime variables and redacted secrets.</td></tr>
          <tr><td><strong>Expressions</strong></td><td>Parse and test broadcast expressions before saving a workflow.</td></tr>
          <tr><td><strong>Settings</strong></td><td>Create scoped API keys and inspect server configuration.</td></tr>
        </tbody>
      </table>

      <h3>Overview and live activity</h3>
      <img src="/screenshots/overview.png" alt="Overview with run totals, recent failures, and live activity" style={shotStyle} />
      <p>
        Status cards and failure rows come from durable adapters. Live Activity
        arrives over the dashboard connection, so the green header dot confirms
        that new events can arrive without a refresh. Click a failed run to see
        its validated input, output, attempts, steps, and captured logs.
      </p>

      <h3>Signals and broadcasts</h3>
      <img src="/screenshots/signals.png" alt="Signals catalog with trigger controls and execution limits" style={shotStyle} />
      <p>
        A signal page is the quickest way to test a definition: Station renders
        its Zod schema as a form, also offers raw JSON, and records the resulting
        run. The configuration panel distinguishes station-local and fleet-wide
        concurrency and shows placement labels. Broadcast pages render the DAG,
        then color nodes as their underlying signal runs change state.
      </p>
      <img src="/screenshots/broadcasts.png" alt="Broadcast catalog with release-pipeline and trigger action" style={shotStyle} />

      <h3>Schedules</h3>
      <img src="/screenshots/schedules.png" alt="Runtime schedules showing an interval signal and timezone cron broadcast" style={shotStyle} />
      <p>
        Schedules can target a signal or broadcast. Use an interval for elapsed
        cadence, or five-field cron plus an IANA timezone for wall-clock time.
        Preview before saving. In a network, durable occurrence claims make one
        Headquarters instance enqueue each occurrence once. The displayed time
        is when work becomes eligible; queue pressure can delay handler start.
      </p>

      <h3>Station Network</h3>
      <img src="/screenshots/station-network.png" alt="Headquarters with CPU and GPU execution stations" style={shotStyle} />
      <p>
        Every row shows the stable station identity, role, lease-backed status,
        active/max capacity, advertised definitions, and last heartbeat. Drain a
        worker before deployment: current runs may finish, while new claims stop.
        An offline row means its lease expired, not merely that a browser lost
        its dashboard connection.
      </p>
      <p>On a phone, navigation collapses to its icons and wide operational tables scroll horizontally.</p>
      <img src="/screenshots/station-network-mobile.png" alt="Responsive Station Network dashboard on a phone" style={{ ...shotStyle, maxWidth: "390px" }} />

      <h3>Beacons</h3>
      <img src="/screenshots/beacons.png" alt="Fleet beacon catalog showing a running heartbeat poller" style={shotStyle} />
      <p>
        Beacons are supervised long-running services or pollers. Headquarters
        receives their definition metadata from workers, while shared state
        tracks which station owns each instance. Start mode controls whether an
        instance is seeded automatically, seeded stopped, or created only by an
        API request. Restart counts and events help distinguish clean exits from
        crash loops or heartbeat stalls.
      </p>

      <h3>Environment and secrets</h3>
      <img src="/screenshots/environment.png" alt="Environment page with a redacted global ASSET_BUCKET value" style={shotStyle} />
      <p>
        Variables can be global or scoped to named signals and beacons. Secrets
        are write-only in the API and stay redacted in the UI. A definition that
        declares <code>.env(&quot;ASSET_BUCKET&quot;)</code> will not start until a matching
        value exists; a scoped value overrides a global value with the same key.
      </p>

      <hr className="divider" />
      <h3>Configuration reference</h3>
      <table className="api-table">
        <thead><tr><th>Option</th><th>What it controls</th></tr></thead>
        <tbody>
          <tr><td><code>port</code> / <code>host</code></td><td>Single public UI and API listener. Defaults to <code>4400</code> / <code>localhost</code>.</td></tr>
          <tr><td><code>role</code></td><td><code>standalone</code>, <code>headquarters</code>, or execution <code>station</code>.</td></tr>
          <tr><td><code>network</code></td><td>Fleet ID, stable station ID/name, durable membership adapter, labels, endpoint, heartbeat, and lease timing.</td></tr>
          <tr><td><code>signalsDir</code>, <code>broadcastsDir</code>, <code>beaconsDir</code></td><td>Definition discovery roots.</td></tr>
          <tr><td><code>adapter</code> and specialized adapters</td><td>Durable signal, broadcast, beacon, schedule, environment, key, and log state.</td></tr>
          <tr><td><code>runner.maxConcurrent</code></td><td>Total signal processes allowed on this Station. Signal declarations can apply narrower local/fleet caps.</td></tr>
          <tr><td><code>runRunners</code></td><td>Whether this process executes work; defaults to false for Headquarters and true otherwise.</td></tr>
          <tr><td><code>auth</code></td><td>Dashboard credentials, session lifetime, and optional API-key storage.</td></tr>
        </tbody>
      </table>

      <h3>Operator checklist</h3>
      <ul>
        <li>Use the same durable adapters on every process participating in one fleet.</li>
        <li>Give every process a unique, stable <code>network.stationId</code>.</li>
        <li>Restrict dashboard credentials and give automation only the API scopes it needs.</li>
        <li>Alert on repeated failures, offline workers, stale heartbeats, and beacon restart loops.</li>
        <li>Drain workers before deployments and verify active capacity reaches zero.</li>
        <li>Back up adapter state and test expired-lease recovery before production rollout.</li>
      </ul>

      <p>
        Next: <Link href="/docs/network">design a Station Network</Link>, run the
        <Link href="/docs/examples/station-network"> local three-process example</Link>,
        or use the <Link href="/docs/station">complete StationKit API reference</Link>.
      </p>
    </>
  );
}
