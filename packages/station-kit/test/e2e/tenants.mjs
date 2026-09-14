import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createStation } from '../../src/server/index.ts';
import { resolveConfig } from '../../src/config/schema.ts';
import { KeyStore, MemoryKeyStorage } from '../../src/server/auth/keys.ts';
import { StationNetworkMemoryAdapter } from 'station-network';
import { ContainerSandboxAdapter } from 'station-sandbox/container';
import { ContainerBrowserAdapter } from 'station-browser-use/container';
import { BrowserSessionManager } from 'station-browser-use';
const executable = process.env.STATION_CONTAINER_ENGINE;
const browserImage = process.env.STATION_BROWSER_CONTAINER_IMAGE;
async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }
const pause = ms => new Promise(r => setTimeout(r, ms));

test('public tenant keys control real isolated containers through Headquarters without cross-tenant access', { skip: !executable || !browserImage, timeout: 300_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'station-tenant-e2e-'));
  const network = new StationNetworkMemoryAdapter();
  const token = randomBytes(32).toString('hex');
  const keyStorage = new MemoryKeyStorage();
  const keys = new KeyStore(keyStorage);
  const a = await keys.create('customer-a', ['execution']);
  const b = await keys.create('customer-b', ['execution']);
  const admin = await keys.create('operator', ['admin']);
  const stations = [], adapters = [], managers = [];
  t.after(async () => {
    for (const adapter of adapters) { for (const ws of await adapter.list().catch(() => [])) await adapter.destroy(ws.id).catch(() => {}); }
    for (const manager of managers) await manager.close().catch(() => {});
    for (const station of stations.reverse()) await station.stop();
    for (const adapter of adapters) await adapter.close();
    rmSync(root, { recursive: true, force: true });
  });
  const engine = executable.includes('podman') ? 'podman' : 'docker';
  for (const tenantId of ['a', 'b']) {
    const port = await freePort();
    const sandbox = new ContainerSandboxAdapter({ rootDir: join(root, tenantId, 'sandbox'), tenantId, executable, engine, image: process.env.STATION_CONTAINER_IMAGE ?? 'docker.io/library/node:22-bookworm-slim', network: 'none', maxEnvironments: 1, maxConcurrent: 1, enablePty: false });
    adapters.push(sandbox);
    const browser = new BrowserSessionManager(new ContainerBrowserAdapter({ rootDir: join(root, tenantId, 'browser'), tenantId, executable, engine, image: browserImage, network: 'none', workerPath: '/opt/station/container-fixture.mjs' }), 1, { recordingRootDir: join(root, tenantId, 'recordings'), stateRootDir: join(root, tenantId, 'browser-state'), tenantId });
    managers.push(browser);
    const station = await createStation(resolveConfig({ role: 'station', name: tenantId, host: '127.0.0.1', port, open: false, runRunners: false, network: { id: 'public-test', stationId: tenantId, adapter: network, endpoint: `http://127.0.0.1:${port}` }, execution: { token, tenantId, sandbox, browser } }), join(root, tenantId));
    stations.push(station); await station.start();
  }
  const port = await freePort();
  const hq = await createStation(resolveConfig({ role: 'headquarters', host: '127.0.0.1', port, open: false, runRunners: false, network: { id: 'public-test', stationId: 'hq', adapter: network }, auth: { username: 'operator', password: randomBytes(20).toString('hex'), keyStorage }, execution: { token, tenants: { apiKeyTenants: { [a.record.id]: 'a', [b.record.id]: 'b' } } } }), join(root, 'hq'));
  stations.push(hq); await hq.start();
  const url = `http://127.0.0.1:${port}/api/v1`;
  const call = (key, owner, primitive, body, extra = {}) => fetch(`${url}/tenant/stations/${owner}/execution/${primitive}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const rpc = async (key, owner, primitive, body) => { const response = await call(key, owner, primitive, body); assert.equal(response.status, 200, await response.clone().text()); return (await response.json()).data; };
  for (const [key, owner] of [[a.key, 'a'], [b.key, 'b']]) {
    const result = await fetch(`${url}/tenant/execution`, { headers: { authorization: `Bearer ${key}` } });
    assert.deepEqual((await result.json()).data.map(n => n.stationId), [owner]);
  }
  assert.equal((await call(a.key, 'b', 'sandbox', { method: 'create' }, { 'x-station-execution-tenant': 'b' })).status, 404);
  assert.equal((await call(admin.key, 'a', 'sandbox', { method: 'create' })).status, 403);
  assert.equal((await fetch(`${url}/execution`, { headers: { authorization: `Bearer ${a.key}` } })).status, 403);
  assert.equal((await fetch(`${url}/keys`, { method: 'POST', headers: { authorization: `Bearer ${a.key}`, 'content-type': 'application/json' }, body: JSON.stringify({name:'escalation',scopes:['admin']}) })).status, 403);
  for (const path of ['stations', 'runs', 'keys']) assert.equal((await fetch(`${url}/${path}`, { headers: { authorization: `Bearer ${a.key}` } })).status, 403, path);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/signals`, { headers: { authorization: `Bearer ${a.key}` } })).status, 401);
  const one = await rpc(a.key, 'a', 'sandbox', { method: 'create' });
  const two = await rpc(b.key, 'b', 'sandbox', { method: 'create' });
  assert.equal((await call(a.key, 'a', 'sandbox', { method: 'create' })).status, 429);
  const fixture = resolve('packages/station-kit/test/e2e/fixtures/custom-tool');
  const pack = spawnSync('npm', ['pack', fixture, '--ignore-scripts', '--pack-destination', root], { encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const base64 = readFileSync(join(root, 'station-dashboard-e2e-tool-1.0.0.tgz')).toString('base64');
  await rpc(a.key, 'a', 'sandbox', { method: 'writeFile', id: one.id, path: 'tool.tgz', options: { base64 } });
  const run = await rpc(a.key, 'a', 'sandbox', { method: 'exec', id: one.id, command: 'npm install --global --offline --ignore-scripts --no-audit --no-fund ./tool.tgz && station-e2e-tool tenant-a', timeoutMs: 30_000 });
  let completed;
  for (let i = 0; i < 200; i++) { completed = await rpc(a.key, 'a', 'sandbox', { method: 'command', id: one.id, runId: run.id }); if (completed.status !== 'running') break; await pause(150); }
  assert.equal(completed.status, 'completed', completed.stderr); assert.match(completed.stdout, /tenant-a/);
  assert.equal((await call(b.key, 'b', 'sandbox', { method: 'readFile', id: one.id, path: 'tool.tgz' })).status, 404);
  assert.equal((await call(b.key, 'b', 'sandbox', { method: 'readFile', id: two.id, path: 'tool.tgz' })).status, 404);
  const browser = await rpc(a.key, 'a', 'browser', { method: 'open' });
  await rpc(a.key, 'a', 'browser', { method: 'action', id: browser.id, action: 'navigate', value: 'http://127.0.0.1:8765' });
  const png = await rpc(a.key, 'a', 'browser', { method: 'action', id: browser.id, action: 'screenshot' });
  assert.equal(png.mimeType, 'image/png'); assert.ok(Buffer.from(png.base64, 'base64').length > 100);
  assert.equal((await call(b.key, 'a', 'browser', { method: 'action', id: browser.id, action: 'screenshot' })).status, 404);
  assert.equal((await call(b.key, 'b', 'browser', { method: 'close', id: browser.id })).status, 404);
  await rpc(a.key, 'a', 'browser', { method: 'close', id: browser.id });
  await keys.revoke(a.record.id);
  assert.equal((await call(a.key, 'a', 'sandbox', { method: 'list' })).status, 401);
  // A different Station directory must not let an operator accidentally relabel retained tenant storage.
  await stations[0].stop();
  assert.throws(() => new ContainerSandboxAdapter({ rootDir: join(root, 'a', 'sandbox'), tenantId: 'b', executable, engine, image: process.env.STATION_CONTAINER_IMAGE ?? 'docker.io/library/node:22-bookworm-slim' }), /tenant|bound|ownership/i);
  assert.throws(() => new ContainerBrowserAdapter({ rootDir: join(root, 'a', 'browser'), tenantId: 'b', executable, engine, image: browserImage }), /tenant|bound|ownership/i);
  const recovered = new ContainerSandboxAdapter({ rootDir: join(root, 'a', 'sandbox'), tenantId: 'a', executable, engine, image: process.env.STATION_CONTAINER_IMAGE ?? 'docker.io/library/node:22-bookworm-slim', network: 'none', enablePty: false });
  adapters.push(recovered);
  await recovered.ready();
  assert.equal((await recovered.get(one.id)).id, one.id);
  // Matching constructor owner with a mismatched Station owner also refuses admission.
  await assert.rejects(createStation(resolveConfig({ role: 'station', open: false, runRunners: false, execution: { token, tenantId: 'b', sandbox: recovered } }), join(root, 'new-station-directory')), /tenant|ownership/i);
  const cleanup = new ContainerSandboxAdapter({ rootDir: join(root, 'a', 'sandbox'), tenantId: 'a', executable, engine, image: process.env.STATION_CONTAINER_IMAGE ?? 'docker.io/library/node:22-bookworm-slim', network: 'none', enablePty: false });
  adapters.push(cleanup); await cleanup.ready();
  console.log('[tenant-e2e] real Headquarters, two tenant workers, offline custom install, file isolation, browser screenshot, cross-tenant denial, capacity and key revocation passed');
});
