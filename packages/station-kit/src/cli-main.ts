import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "./config/loader.js";
import { createStation } from "./server/index.js";

const cwd = process.cwd();

const config = await loadConfig(cwd);

const station = await createStation(config, cwd);
await station.start();

// Start Next.js dev server as child process
const nextPort = config.port + 1;
const stationRoot = resolve(import.meta.dirname, "..");

const nextProcess: ChildProcess = spawn(
  "npx",
  ["next", "dev", "--port", String(nextPort), "--hostname", config.host],
  {
    cwd: stationRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NEXT_PUBLIC_STATION_API: `http://${config.host}:${config.port}`,
    },
  },
);

nextProcess.stdout?.on("data", (chunk: Buffer) => {
  const msg = chunk.toString().trim();
  if (msg) console.log(`[station:ui] ${msg}`);
});

nextProcess.stderr?.on("data", (chunk: Buffer) => {
  const msg = chunk.toString().trim();
  // Filter out noisy Next.js dev warnings
  if (msg && !msg.includes("ExperimentalWarning")) {
    console.error(`[station:ui] ${msg}`);
  }
});

console.log(`[station] Dashboard on http://${config.host}:${nextPort}`);

// Open browser
if (config.open) {
  const url = `http://${config.host}:${nextPort}`;
  const { execFile } = await import("node:child_process");
  const platform = process.platform;

  await new Promise((res) => setTimeout(() => res(true), 5000));
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
  nextProcess.kill("SIGTERM");
  await station.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
