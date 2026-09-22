import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { MemoryAdapter } from 'station-signal';
import { StationNetworkMemoryAdapter } from 'station-network';
import { createStation } from '../../src/server/index.js';
import { resolveConfig } from '../../src/config/schema.js';

process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve('tsx'));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function wait(check: () => Promise<boolean>) { const until = Date.now() + 10000; while (Date.now() < until) { if (await check()) return; await pause(20); } throw new Error('Enrollment integration timed out'); }
async function port() { const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const p = (s.address() as {port:number}).port; await new Promise<void>(r => s.close(() => r())); return p; }

test('revoked enrolled daemon stops claims and cannot resurrect itself by heartbeat', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-enrollment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const network = new StationNetworkMemoryAdapter(), queue = new MemoryAdapter();
  const common = { host: '127.0.0.1', auth: { username: 'operator', password: 'local-enrollment-test' }, adapter: queue, runner: { pollIntervalMs: 30, maxConcurrent: 2 }, signalsDir: fileURLToPath(new URL('./fixtures/signals', import.meta.url)) };
  const hqPort = await port(), url = `http://127.0.0.1:${hqPort}`;
  const hq = await createStation(resolveConfig({ ...common, port: hqPort, role: 'headquarters', stationDir: join(root, 'hq'), network: { id: 'enrollment-test', stationId: 'hq', adapter: network, enrollment: { authority: true } } }), root);
  t.after(() => hq.stop()); await hq.start();
  const key = await hq.keyStore!.create('operator', ['admin', 'trigger']);
  async function request(path: string, method: string, body?: unknown, token = key.key) { return fetch(`${url}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  const issued = await request('/network/enrollments', 'POST', { stationId: 'member' }); assert.equal(issued.status, 201);
  const invitation = (await issued.json()).data;
  const joined = await request('/network/join', 'POST', { token: invitation.token, stationId: 'member', networkId: 'enrollment-test' }, ''); assert.equal(joined.status, 201);
  const membership = (await joined.json()).data;
  const workerConfig = resolveConfig({ ...common, port: 0, role: 'station', stationDir: join(root, 'worker'), network: { id: 'enrollment-test', stationId: 'member', adapter: network, heartbeatIntervalMs: 30, enrollment: { url, credential: membership.credential } } });
  const worker = await createStation(workerConfig, root); t.after(() => worker.stop()); await worker.start();
  const triggered = await request('/trigger', 'POST', { signalName: 'ping', input: { label: 'admitted' } }); assert.equal(triggered.status, 201); const id = (await triggered.json()).data.id;
  await wait(async () => (await queue.getRun(id))?.status === 'completed');
  await queue.addRun({ id: 'active-revoke', signalName: 'network-work', kind: 'trigger', input: JSON.stringify({ id: 1, delayMs: 2000 }), status: 'pending', attempts: 0, maxAttempts: 1, timeout: 5000, createdAt: new Date() });
  await wait(async () => (await queue.getRun('active-revoke'))?.status === 'running');
  assert.equal((await request('/network/members/member', 'DELETE')).status, 204);
  await wait(async () => (await network.getStation('member'))?.status === 'offline');
  await wait(async () => (await queue.getRun('active-revoke'))?.status !== 'running');
  assert.notEqual((await queue.getRun('active-revoke'))?.status, 'completed', 'a revoked active child cannot report successful completion');
  await network.removeStation('member');
  await queue.addRun({ id: 'blocked', signalName: 'ping', kind: 'trigger', input: JSON.stringify({ label: 'revoked' }), status: 'pending', attempts: 0, maxAttempts: 1, timeout: 1000, createdAt: new Date() });
  await pause(250);
  assert.equal(await network.getStation('member'), null, 'heartbeat must not recreate a revoked member');
  assert.equal((await queue.getRun('blocked'))?.status, 'pending', 'revoked worker cannot claim queued work');
  assert.equal((await request('/network/admission', 'POST', { networkId: 'enrollment-test', stationId: 'member' }, membership.credential)).status, 401);
  const denied = await createStation(workerConfig, root);
  await assert.rejects(denied.start(), /admission denied/);
  await denied.stop();
});
