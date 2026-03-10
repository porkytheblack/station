import { createStation } from "station-kit/server";
import { resolveConfig, type StationUserConfig } from "station-kit";
import { getOrCreateApiKey } from "./auth.js";

export interface TauriStationConfig {
  /** Port for the HTTP API server. Default: 4400 */
  port?: number;
  /** Absolute path to app data directory (Tauri provides this) */
  dataDir: string;
  /** Path to signals directory */
  signalsDir: string;
  /** Path to broadcasts directory (optional) */
  broadcastsDir?: string;
  /** Additional station config overrides */
  station?: Partial<StationUserConfig>;
}

export interface TauriStation {
  /** Start the Station server + runners */
  start(): Promise<void>;
  /** Stop gracefully */
  stop(): Promise<void>;
  /** The port the server is listening on */
  port: number;
  /** Auto-provisioned API key for the Tauri frontend */
  apiKey: string;
}

/**
 * Create a Station instance configured for Tauri desktop apps.
 *
 * - Binds to 127.0.0.1 only (no external access)
 * - Auto-provisions an API key (no login UI needed)
 * - Stores data in the Tauri app data directory
 * - Runs without the Next.js dashboard
 */
export async function createTauriStation(opts: TauriStationConfig): Promise<TauriStation> {
  const port = opts.port ?? 4400;

  // Spread user overrides first, then enforce security-critical defaults
  const config = resolveConfig({
    ...opts.station,
    port,
    host: "127.0.0.1",
    open: false,
    signalsDir: opts.signalsDir,
    broadcastsDir: opts.broadcastsDir,
    stationDir: opts.dataDir,
    runRunners: true,
    auth: {
      username: "tauri",
      password: crypto.randomUUID(),
    },
  });

  const station = await createStation(config, process.cwd());

  // Use the KeyStore already created by createStation (same DB, no double-open)
  if (!station.keyStore) {
    throw new Error("Station auth was not initialized — this should not happen");
  }
  const apiKey = getOrCreateApiKey(station.keyStore, station.dataDir);

  return {
    port,
    apiKey,
    async start() {
      await station.start();
    },
    async stop() {
      await station.stop();
    },
  };
}
