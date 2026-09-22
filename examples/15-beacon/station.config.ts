import { defineConfig } from "station-daemon";

// Run the daemon with these beacons:  pnpm exec stationd
// Then open http://localhost:4400/beacons
export default defineConfig({
  port: 4400,
  beaconsDir: "./beacons",
});
