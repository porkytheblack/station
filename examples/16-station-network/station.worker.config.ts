import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BeaconSqliteAdapter } from "station-adapter-sqlite/beacon";
import { EnvSqliteAdapter } from "station-adapter-sqlite/env";
import { StationNetworkSqliteAdapter } from "station-adapter-sqlite/network";

const dbPath = "./station-network-demo.db";
const stationId = process.env.STATION_ID ?? "worker-ke-1";
const port = Number(process.env.STATION_PORT ?? 5610);

export default defineConfig({
  role: "station",
  host: "127.0.0.1",
  port,
  open: false,
  stationDir: `.station/${stationId}`,
  signalsDir: "./signals",
  beaconsDir: "./beacons",
  adapter: new SqliteAdapter({ dbPath }),
  beaconAdapter: new BeaconSqliteAdapter({ dbPath }),
  envStorage: new EnvSqliteAdapter({ dbPath }),
  network: {
    id: "release-demo",
    stationId,
    name: process.env.STATION_NAME ?? stationId,
    adapter: new StationNetworkSqliteAdapter({ dbPath }),
    labels: {
      region: process.env.STATION_REGION ?? "ke",
      gpu: process.env.STATION_GPU ?? "false",
    },
    endpoint: `http://127.0.0.1:${port}`,
  },
  runner: { pollIntervalMs: 100, maxConcurrent: 4 },
});
