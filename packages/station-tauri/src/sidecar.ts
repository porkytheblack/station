#!/usr/bin/env node
import { createTauriStation } from "./index.js";

const dataDir = process.env.STATION_DATA_DIR;
if (!dataDir) {
  console.error("STATION_DATA_DIR is required");
  process.exit(1);
}

const signalsDir = process.env.STATION_SIGNALS_DIR || "./signals";
const broadcastsDir = process.env.STATION_BROADCASTS_DIR;
const port = parseInt(process.env.STATION_PORT || "4400", 10);

try {
  const station = await createTauriStation({
    dataDir,
    port,
    signalsDir,
    broadcastsDir: broadcastsDir || undefined,
  });

  await station.start();

  // Signal readiness to Tauri — Tauri reads stdout and parses this JSON line
  console.log(JSON.stringify({
    event: "ready",
    port: station.port,
    apiKey: station.apiKey,
  }));

  // Graceful shutdown with re-entrancy guard
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    await station.stop();
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} catch (err) {
  // Output structured error so Tauri can parse it
  console.log(JSON.stringify({
    event: "error",
    message: err instanceof Error ? err.message : String(err),
  }));
  process.exit(1);
}
