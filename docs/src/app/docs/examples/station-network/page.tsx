import { Metadata } from "next";
import Link from "next/link";
import { Code } from "../../../components/Code";

export const metadata: Metadata = {
  title: "Station Network Example — Station",
};

export default function StationNetworkExamplePage() {
  return (
    <>
      <div className="eyebrow">Example 12</div>
      <h2 style={{ marginTop: 0 }}>From one Station to a fleet</h2>
      <p>
        Run one logical Headquarters and two execution stations on your laptop.
        This is the smallest topology that demonstrates real distribution,
        placement, draining, shared schedules, and worker recovery.
      </p>

      <img
        src="/screenshots/station-network.png"
        alt="Station Network dashboard showing Headquarters, a GPU station, and a CPU station with live capacity and heartbeat data"
        className="doc-screenshot"
      />

      <div className="info-box">
        <p>
          The working source is in <code>examples/16-station-network</code>.
          SQLite coordinates these local processes because they share one
          filesystem. Across machines, switch all shared adapters to PostgreSQL,
          MySQL, or Redis.
        </p>
      </div>

      <h3>1. Define work with two levels of capacity</h3>
      <Code>{`import { signal, z } from "station-signal";

export const renderPreview = signal("render-preview")
  .input(z.object({ release: z.string() }))
  .env("ASSET_BUCKET")
  .concurrency({ station: 1, network: 1 })
  .placement({ labels: { gpu: "true", region: "ke" } })
  .run(async ({ release }) => {
    return renderTo(process.env.ASSET_BUCKET!, release);
  });`}</Code>
      <p>
        <code>station: 1</code> protects each worker. <code>network: 1</code>
        protects the fleet. Placement means only an online station with both
        labels may claim this signal.
      </p>

      <h3>2. Configure Headquarters</h3>
      <Code>{`export default defineConfig({
  role: "headquarters",
  port: 5600,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath }),
  beaconAdapter: new BeaconSqliteAdapter({ dbPath }),
  scheduleAdapter: new ScheduleSqliteAdapter({ dbPath }),
  envStorage: new EnvSqliteAdapter({ dbPath }),
  network: {
    id: "release-demo",
    stationId: "headquarters",
    adapter: new StationNetworkSqliteAdapter({ dbPath }),
  },
  auth: { username: "admin", password: "station" },
});`}</Code>
      <p>
        Headquarters serves the API and dashboard, validates definitions,
        reconciles schedules and broadcasts, and enqueues work. Its signal
        execution capacity is always zero.
      </p>

      <h3>3. Configure reusable workers</h3>
      <Code>{`export default defineConfig({
  role: "station",
  port: Number(process.env.STATION_PORT),
  signalsDir: "./signals",
  beaconsDir: "./beacons",
  adapter: new SqliteAdapter({ dbPath }),
  beaconAdapter: new BeaconSqliteAdapter({ dbPath }),
  envStorage: new EnvSqliteAdapter({ dbPath }),
  network: {
    id: "release-demo",
    stationId: process.env.STATION_ID!,
    adapter: new StationNetworkSqliteAdapter({ dbPath }),
    labels: {
      region: process.env.STATION_REGION!,
      gpu: process.env.STATION_GPU!,
    },
  },
  runner: { maxConcurrent: 4 },
});`}</Code>

      <h3>4. Start the topology</h3>
      <Code>{`# Terminal 1
pnpm hq

# Terminal 2
STATION_ID=worker-ke-1 STATION_PORT=5610 STATION_GPU=true pnpm worker

# Terminal 3
STATION_ID=worker-ke-2 STATION_PORT=5620 STATION_GPU=false pnpm worker`}</Code>
      <p>
        Open <code>http://127.0.0.1:5600</code>, sign in, and visit
        <strong> Stations</strong>. Create <code>ASSET_BUCKET</code> under
        <strong> Environment</strong>, then trigger work from a signal page or
        create a runtime schedule.
      </p>

      <h3>What to prove before production</h3>
      <ul>
        <li>One run and one schedule occurrence have exactly one owner.</li>
        <li>Unconstrained work reaches more than one eligible station.</li>
        <li>Station and network concurrency never exceed their declarations.</li>
        <li>GPU work never reaches a CPU-only station.</li>
        <li>A draining station receives no new work.</li>
        <li>Expired leases recover, and stale owners cannot commit results.</li>
        <li>Shutdown lets active work finish and marks the station offline.</li>
      </ul>

      <p>
        Continue with the full <Link href="/docs/network">Station Networks guide</Link>
        for adapter selection, beacon proxying, timing semantics, and production
        security.
      </p>
    </>
  );
}
