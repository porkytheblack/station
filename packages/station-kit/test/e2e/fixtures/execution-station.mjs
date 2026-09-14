// A separate OS process for each real Station service in the dashboard E2E.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createStation } from '../../../dist/server/index.js';
import { resolveConfig } from '../../../dist/config/schema.js';
import { StationNetworkSqliteAdapter } from 'station-adapter-sqlite/network';
import { HostSandboxAdapter } from 'station-sandbox';
import { BrowserSessionManager } from 'station-browser-use';
import { BunBrowserAdapter } from 'station-browser-use/bun';
import { PlaywrightBrowserAdapter } from 'station-browser-use/playwright';

const options = JSON.parse(process.env.STATION_E2E_OPTIONS);
mkdirSync(options.cwd, { recursive: true });
const network = process.env.STATION_E2E_DATABASE_URL
  ? new (await import('../../../../station-adapter-postgres/dist/network.js')).StationNetworkPostgresAdapter({ connectionString: process.env.STATION_E2E_DATABASE_URL, tablePrefix: options.tablePrefix })
  : new StationNetworkSqliteAdapter({ dbPath: options.networkPath });
const execution = { token: options.token };
if (options.primitive === 'sandbox') execution.sandbox = new HostSandboxAdapter({
  rootDir: join(options.cwd, 'workspaces'), maxConcurrent: 2, maxTimeoutMs: 60_000, enablePty: true,
});
if (options.primitive === 'bun' || options.primitive === 'playwright') {
  execution.browser = new BrowserSessionManager(options.primitive === 'bun' ? new BunBrowserAdapter() : new PlaywrightBrowserAdapter({ profileRootDir: join(options.cwd, 'profiles') }), 2, { recordingRootDir: join(options.cwd, 'recordings') });
}
const station = await createStation(resolveConfig({
  name: options.id, role: options.id === 'hq' ? 'headquarters' : 'station',
  host: '127.0.0.1', port: options.port, open: false, runRunners: false,
  network: {
    id: 'dashboard-e2e', stationId: options.id,
    adapter: network,
    endpoint: `http://127.0.0.1:${options.port}`, heartbeatIntervalMs: 200, leaseDurationMs: 10_000,
    labels: { purpose: options.primitive ?? 'headquarters' },
  },
  auth: options.id === 'hq' ? { username: 'e2e', password: options.password } : undefined,
  execution,
}), options.cwd, options.nextPort);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await station.stop(); process.disconnect?.(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
process.on('message', (message) => { if (message === 'stop') void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
await station.start();
process.send?.({ ready: true });
