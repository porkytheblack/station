import { defineConfig } from "station-kit";

export default defineConfig({
  port: 5500,
  signalsDir: "./signals",
  auth: {
    username: "admin",
    password: "station",
  },
});