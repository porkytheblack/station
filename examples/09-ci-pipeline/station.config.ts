import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 5500,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./.station/data/jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./.station/data/jobs.db" }),
  auth: {
    password: "don",
    username: "don"
  }
});
