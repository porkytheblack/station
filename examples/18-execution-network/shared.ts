import { PostgresAdapter } from "station-adapter-postgres";
import { StationNetworkPostgresAdapter } from "station-adapter-postgres/network";
import { SchedulePostgresAdapter } from "station-adapter-postgres/schedules";
import type { StationUserConfig } from "station-daemon";

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
export function shared(stationId: string, port: number): StationUserConfig {
  const connectionString = required("DATABASE_URL");
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? port),
    stationDir: process.env.STATION_DATA_DIR ?? `.station/${stationId}`,
    adapter: new PostgresAdapter({ connectionString }),
    scheduleAdapter: new SchedulePostgresAdapter({ connectionString }),
    network: {
      id: "execution-demo", stationId,
      adapter: new StationNetworkPostgresAdapter({ connectionString }),
      endpoint: process.env.STATION_ENDPOINT ?? `http://127.0.0.1:${port}`,
      labels: { execution: stationId },
    },
  };
}
