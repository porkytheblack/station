import { defineConfig } from "station-kit";

export default defineConfig({
  port: 4400,
  signalsDir: "./signals",
  auth: {
    username: "admin",
    password: "station",
  },
});