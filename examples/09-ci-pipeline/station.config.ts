import { defineConfig } from "@simple-signal/station";
import { SqliteAdapter } from "@simple-signal/adapter-sqlite";
import { BroadcastSqliteAdapter } from "@simple-signal/adapter-sqlite/broadcast";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  broadcastsDir: "./broadcasts",
  adapter: new SqliteAdapter({ dbPath: "./jobs.db" }),
  broadcastAdapter: new BroadcastSqliteAdapter({ dbPath: "./jobs.db" }),
});
