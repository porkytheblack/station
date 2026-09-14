import { defineConfig } from "station-kit";
import { HostSandboxAdapter } from "station-sandbox";
import { shared, required } from "./shared.js";

export default defineConfig({
  ...shared("sandbox", 5701), role: "station",
  execution: {
    token: required("STATION_EXECUTION_TOKEN"),
    sandbox: new HostSandboxAdapter({
      rootDir: process.env.SANDBOX_ROOT ?? ".station/sandbox/workspaces",
      maxEnvironments: 8, maxConcurrent: 3, maxTimeoutMs: 300_000,
      // Explicit allowlist only. Database and service-token variables are not inherited.
      env: {},
    }),
  },
});
