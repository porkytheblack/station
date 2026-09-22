import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveConfig } from '../../packages/station-daemon/dist/index.js';
import { createStation } from '../../packages/station-daemon/dist/server/index.js';
import { ContainerSandboxAdapter } from '../../packages/station-sandbox/dist/container.js';
import { root, stateDir } from './shared.mjs';

const settings = JSON.parse(readFileSync(`${stateDir}/settings.json`, 'utf8'));
const adapter = new ContainerSandboxAdapter({
  rootDir: `${stateDir}/workspaces`, image: settings.image,
  seccompProfile: `${stateDir}/seccomp.json`, network: 'bridge',
  memoryMb: 3072, cpus: 2, pidsLimit: 256,
  maxEnvironments: 1, maxConcurrent: 6, maxServicesPerSandbox: 4,
  maxTerminalsPerSandbox: 3, maxTimeoutMs: 300000, maxOutputBytes: 131072,
  enablePty: true,
  env: { HERMES_HOME: '/home/node/.hermes', HERMES_GATEWAY_NO_SUPERVISE: '1',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', TZ: 'Africa/Nairobi' },
});
await adapter.ready();
const station = await createStation(resolveConfig({
  host: process.env.STATION_BIND_HOST ?? '127.0.0.1', port: 5800, stationDir: `${stateDir}/daemon`,
  network: { stationId: 'hermes-worker', name: 'Hermes Docker worker' },
  auth: { username: settings.username, password: settings.password, secureCookies: false },
  execution: { token: settings.executionToken, sandbox: adapter },
}), root);
if (!existsSync(`${stateDir}/api-key`)) {
  const { key } = await station.keyStore.create('Local Hermes setup', ['admin', 'read', 'trigger', 'execution']);
  writeFileSync(`${stateDir}/api-key`, key, { mode: 0o600 });
}
await station.start();
const closeTLS = process.env.STATION_TLS_PROXY === '1'
  ? await (await import('./tls-proxy.mjs')).startTLSProxy(stateDir) : undefined;
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await closeTLS?.(); await station.stop(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
