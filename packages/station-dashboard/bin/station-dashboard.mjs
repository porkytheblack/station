#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dashboardProxy, targetURL } from './proxy.mjs';

if (process.argv.includes('--help')) {
  console.log('station-dashboard\nEnvironment: STATION_DAEMON_URL (http://127.0.0.1:4400), PORT (4401), STATION_DASHBOARD_HOST (127.0.0.1)');
  process.exit(0);
}
const daemon = targetURL(process.env.STATION_DAEMON_URL ?? 'http://127.0.0.1:4400');
const host = process.env.STATION_DASHBOARD_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.PORT ?? '4401');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dashboard PORT');
const entry = fileURLToPath(new URL('../.next/standalone/packages/station-dashboard/server.js', import.meta.url));
if (!existsSync(entry)) throw new Error('Build station-dashboard before starting it.');
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
const internalPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: String(internalPort), HOSTNAME: '127.0.0.1' } });
const proxy = dashboardProxy(daemon.href, `http://127.0.0.1:${internalPort}`);
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  await proxy.close();
  child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000); kill.unref();
  process.exitCode = code;
};
child.on('error', (error) => { console.error(error.message); void stop(1); });
child.on('exit', (code) => { if (!stopping) void stop(code ?? 1); });
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Dashboard renderer exited');
    try { await fetch(`http://127.0.0.1:${internalPort}/`, { signal: AbortSignal.timeout(1000) }); break; }
    catch { if (attempt >= 100) throw new Error('Dashboard renderer startup timed out'); await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  await new Promise((resolve, reject) => { proxy.server.once('error', reject); proxy.server.listen(port, host, resolve); });
  console.log(`[station-dashboard] http://${host}:${port} → ${daemon.origin}`);
} catch (error) { console.error(error.message); await stop(1); }
