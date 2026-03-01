import { defineConfig } from "station-kit";
import { PostgresAdapter } from "station-adapter-postgres";

const connectionString = process.env.DATABASE_URL ?? "postgresql://localhost:5432/station";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  adapter: new PostgresAdapter({ connectionString }),
  auth: {
    username: "admin",
    password: "station",
  },
});
