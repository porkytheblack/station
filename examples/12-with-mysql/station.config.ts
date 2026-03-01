import { defineConfig } from "station-kit";
import { MysqlAdapter } from "station-adapter-mysql";

const connectionString = process.env.DATABASE_URL ?? "mysql://root@localhost:3306/station";
const adapter = await MysqlAdapter.create({ connectionString });

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  adapter,
  auth: {
    username: "admin",
    password: "station",
  },
});
