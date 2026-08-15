import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";
import { BeaconSqliteAdapter } from "station-adapter-sqlite/beacon";
import { EnvSqliteAdapter } from "station-adapter-sqlite/env";
import { StationNetworkSqliteAdapter } from "station-adapter-sqlite/network";
import { ScheduleSqliteAdapter } from "station-adapter-sqlite/schedules";

// Keep the shared database at the project root: adapters open during config
// evaluation, before station-kit creates each process's private stationDir.
const dbPath = "./station-network-demo.db";

export default defineConfig({
  role: "headquarters",
  host: "127.0.0.1",
  port: 5600,
  open: false,
  stationDir: ".station/hq",
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
    name: "Release HQ",
    adapter: new StationNetworkSqliteAdapter({ dbPath }),
    labels: { region: "global" },
  },
  auth: { username: "admin", password: "station" },
  runner: { pollIntervalMs: 100 },
});
