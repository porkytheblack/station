import { defineConfig } from "simple-station";
import { SqliteAdapter } from "simple-adapter-sqlite";
import { BroadcastSqliteAdapter } from "simple-adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
});
