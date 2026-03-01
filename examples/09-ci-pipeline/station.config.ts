import { defineConfig } from "station-kit";
import { SqliteAdapter } from "station-adapter-sqlite";
import { BroadcastSqliteAdapter } from "station-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
  auth: {
    password: "don",
    username: "don"
  }
});
