import { defineConfig } from "station-kit";

// Run the dashboard against these beacons:  npx station
// Then open http://localhost:4400/beacons
export default defineConfig({
  port: 4400,
  beaconsDir: "./beacons",
});
