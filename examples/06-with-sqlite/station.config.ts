import { defineConfig } from "station-daemon";
import { SqliteAdapter } from "station-adapter-sqlite";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  adapter: new SqliteAdapter({ dbPath: "./.station/data/jobs.db" }),
  auth: {
    username: "admin",
    password: "station",
  },
});
