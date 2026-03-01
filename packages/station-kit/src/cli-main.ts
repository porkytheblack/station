import { loadConfig } from "./config/loader.js";
import { createStation } from "./server/index.js";

const cwd = process.cwd();

const config = await loadConfig(cwd);

const station = await createStation(config, cwd);
await station.start();

console.log(`[station] Dashboard on http://${config.host}:${config.port}`);

// Open browser
if (config.open) {
  const url = `http://${config.host}:${config.port}`;
  const { execFile } = await import("node:child_process");
  const platform = process.platform;

  await new Promise((res) => setTimeout(() => res(true), 2000));
  if (platform === "darwin") {
    execFile("open", [url]);
  } else if (platform === "linux") {
    execFile("xdg-open", [url]);
  } else if (platform === "win32") {
    execFile("cmd", ["/c", "start", url]);
  }
}

// Graceful shutdown
const shutdown = async () => {
  console.log("\n[station] Shutting down...");
  await station.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
