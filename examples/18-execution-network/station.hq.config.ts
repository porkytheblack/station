import { defineConfig } from "station-daemon";
import { shared, required } from "./shared.js";

export default defineConfig({
  ...shared("hq", 5700), role: "headquarters",
  auth: { username: required("STATION_AUTH_USERNAME"), password: required("STATION_AUTH_PASSWORD") },
  execution: { token: required("STATION_EXECUTION_TOKEN") },
});
