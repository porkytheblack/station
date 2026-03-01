import { defineConfig } from "station-kit";
import { RedisAdapter } from "station-adapter-redis";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  adapter: new RedisAdapter({ url }),
  auth: {
    username: "admin",
    password: "station",
  },
});
