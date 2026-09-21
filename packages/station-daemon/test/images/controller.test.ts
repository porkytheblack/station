import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryAdapter } from 'station-signal';
import { BroadcastMemoryAdapter } from 'station-broadcast';
import { MemoryRegistryMetadataAdapter, MemoryRegistryBlobAdapter, digestBytes, type ImageManifest, type ImageRecord } from 'station-images';
import { createStation } from '../../src/server/index.js';
import { resolveConfig } from '../../src/config/schema.js';
import { imageSignalName, type ImageBackendConfig } from '../../src/images/runtime.js';
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve('tsx'));
const target = { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' as const : 'amd64' as const, abi: process.platform === 'linux' ? 'glibc' as const : 'none' as const, runtimes: { node: Number(process.versions.node.split('.')[0]) } };
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target };
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address(); assert.ok(value && typeof value !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return value.port;
}
async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const until = Date.now() + 15000;
  while (Date.now() < until) { const result = await read(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out waiting for ${label}`);
}
function jsManifest(name: string, bytes: Buffer, exports: ImageManifest['exports'], dependencies?: ImageManifest['dependencies']): ImageManifest {
  return { format: 'station.image/v1', protocol: 'station.process/v1', name, version: '1.0.0', artifacts: [{ digest: digestBytes(bytes), size: bytes.length, entrypoint: 'app.mjs', platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 20 }], exports, ...(dependencies ? { dependencies } : {}) };
}

for (const customStorage of [false, true]) test(`daemon HTTP image publishing runs JS/native signals, a persisted DAG and a managed beacon (${customStorage ? 'adapter storage' : 'filesystem'})`, { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-images-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new MemoryAdapter(), broadcastAdapter = new BroadcastMemoryAdapter();
  const servicePort = await port();
  const station = await createStation(resolveConfig({ host: '127.0.0.1', port: servicePort, stationDir: 'daemon', auth: { username: 'test', password: 'test-only-password' }, adapter, broadcastAdapter, runner: { pollIntervalMs: 15 }, broadcastRunner: { pollIntervalMs: 15 }, network: { stationId: 'image-http', heartbeatIntervalMs: 30 }, registry: { ...(customStorage ? { storage: { id: 'http-adapter-test', metadata: new MemoryRegistryMetadataAdapter(), blobs: new MemoryRegistryBlobAdapter() } } : {}), execution: { backend, allowedEnv: ['IMAGE_TOKEN'] } } }), root);
  t.after(() => station.stop());
  const key = await station.keyStore!.create('test operator', ['admin', 'read', 'trigger']);
  await station.start();
  const base = `http://127.0.0.1:${servicePort}/api/v1`;
  const headers = { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' };
  async function api(path: string, method = 'GET', body?: unknown, expected = 200) {
    const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) });
    const json = await response.json(); assert.equal(response.status, expected, `${path}: ${JSON.stringify(json)}`); return json.data;
  }
  async function publish(manifest: ImageManifest, bytes: Buffer): Promise<ImageRecord> { await api(`/registry/blobs/${manifest.artifacts[0]!.digest}`, 'PUT', bytes, 201); return api('/registry/images', 'POST', manifest, 201); }
  assert.equal((await fetch(`${base}/registry/images`)).status, 401);
  const credential = await api('/env', 'POST', { key: 'IMAGE_TOKEN', value: 'approved', secret: true }, 201); assert.equal(credential.value, null);
  const dependencyBytes = Buffer.from(`let text='';for await(const part of process.stdin)text+=part;const r=JSON.parse(text);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{dependency:true,input:r.input}}));`);
  const dependency = await publish(jsManifest('http/dependency', dependencyBytes, [{ name: 'other', kind: 'signal' }]), dependencyBytes);
  const code = Buffer.from(`import{createInterface}from'node:readline';const send=o=>console.log(JSON.stringify({protocol:'station.process/v1',...o}));let timer;createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type==='invoke'){if(r.export==='workflow')send({type:'result',output:{nodes:[{name:'first',signalName:'echo',dependsOn:[],input:{kind:'ref',path:['input']}},{name:'second',signalName:'other',dependsOn:['first'],input:{kind:'ref',path:['upstream','first']}}]}});else send({type:'result',output:{input:r.input,token:process.env.IMAGE_TOKEN}});}if(r.type==='beacon:init'){send({type:'beacon:started'});send({type:'beacon:ready'});timer=setInterval(()=>send({type:'beacon:heartbeat'}),40);send({type:'trigger',id:'once',dependency:'other',input:{fromBeacon:true}});}if(r.type==='beacon:stop'){clearInterval(timer);send({type:'beacon:stopped'});}});`);
  const image = await publish(jsManifest('http/application', code, [
    { name: 'echo', kind: 'signal', inputSchema: { type: 'object' }, requiredEnv: ['IMAGE_TOKEN'] },
    { name: 'workflow', kind: 'broadcast', planner: 'binary', inputSchema: { type: 'object' } },
    { name: 'watch', kind: 'beacon', mode: 'run', startMode: 'on-demand', configSchema: { type: 'object' } },
  ], { other: { image: `http/dependency@${dependency.digest}`, export: 'other', kind: 'signal' } }), code);
  const installed = await api('/registry/install', 'POST', { reference: image.digest }, 201);
  assert.equal(installed.exports.length, 3);
  const signal = await api('/registry/run', 'POST', { reference: image.digest, export: 'echo', input: { text: 'params through HTTP' } }, 201);
  const run = await waitFor(async () => { const value = await adapter.getRun(signal.id); return value && ['completed', 'failed'].includes(value.status) ? value : undefined; }, 'JS image completion');
  assert.equal(run.status, 'completed', run.error); assert.deepEqual(JSON.parse(run.output!), { input: { text: 'params through HTTP' }, token: 'approved' });
  const broadcast = await api('/registry/run', 'POST', { reference: image.digest, export: 'workflow', input: { message: 'workflow' }, stationId: 'image-http' }, 201);
  const dag = await waitFor(async () => { const value = await broadcastAdapter.getBroadcastRun(broadcast.id); return value && ['completed', 'failed'].includes(value.status) ? value : undefined; }, 'broadcast completion');
  assert.equal(dag.status, 'completed', dag.error);
  const snapshot = JSON.parse(dag.definitionSnapshot!); assert.equal(snapshot.requiredStationId, 'image-http'); assert.equal(snapshot.nodes[0].signalName, imageSignalName(image.digest, 'echo')); assert.equal(snapshot.nodes[1].signalName, imageSignalName(dependency.digest, 'other'));
  const nodes = await api(`/broadcast-runs/${broadcast.id}/nodes`); assert.equal(nodes.length, 2); assert.ok(nodes.every((node: { status: string }) => node.status === 'completed'));
  const beacon = await api('/registry/run', 'POST', { reference: image.digest, export: 'watch', input: {}, stationId: 'image-http' }, 201);
  await waitFor(async () => { const instance = await api(`/beacons/${beacon.registeredName}/instances/${beacon.id}`); return instance.readyAt ? instance : undefined; }, 'beacon ready');
  await waitFor(async () => { const runs = await adapter.listRuns(imageSignalName(dependency.digest, 'other')); return runs.find(candidate => candidate.input === '{"fromBeacon":true}' && candidate.status === 'completed'); }, 'beacon dependency queued');
  await api(`/beacons/${beacon.registeredName}/instances/${beacon.id}/stop`, 'POST', {});
  await waitFor(async () => { const instance = await api(`/beacons/${beacon.registeredName}/instances/${beacon.id}`); return instance.status === 'stopped' ? instance : undefined; }, 'beacon stopped');
  const cSource = join(root, 'native.c'), executable = join(root, 'native');
  await writeFile(cSource, '#include <stdio.h>\nint main(void){char b[8192];if(!fgets(b,sizeof(b),stdin))return 1;puts("{\\"protocol\\":\\"station.process/v1\\",\\"type\\":\\"result\\",\\"output\\":{\\"native\\":true}}");return 0;}');
  execFileSync('cc', [cSource, '-o', executable]);
  const bytes = await readFile(executable);
  const native = await publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'http/native', version: '1.0.0', artifacts: [{ digest: digestBytes(bytes), size: bytes.length, entrypoint: 'native', runtime: 'native', platform: { os: target.os, arch: target.arch, abi: target.abi } }], exports: [{ name: 'native', kind: 'signal' }] }, bytes);
  const nativeJob = await api('/registry/run', 'POST', { reference: native.digest, export: 'native', input: {} }, 201);
  const nativeRun = await waitFor(async () => { const value = await adapter.getRun(nativeJob.id); return value && ['completed', 'failed'].includes(value.status) ? value : undefined; }, 'native image completion');
  assert.equal(nativeRun.status, 'completed', nativeRun.error); assert.deepEqual(JSON.parse(nativeRun.output!), { native: true });
});

test('Adapter-backed Headquarters publication becomes executable on both cold network workers without per-worker install', { timeout: 45000 }, async t => {
  const { SqliteAdapter } = await import('station-adapter-sqlite');
  const { StationNetworkSqliteAdapter } = await import('station-adapter-sqlite/network');
  const { FileImageRegistry } = await import('station-images');
  const root = await mkdtemp(join(tmpdir(), 'station-image-network-')); t.after(() => rm(root, { recursive: true, force: true }));
  const queuePath = join(root, 'queue.db'), networkPath = join(root, 'network.db');
  const hqQueue = new SqliteAdapter({ dbPath: queuePath }), hqNetwork = new StationNetworkSqliteAdapter({ dbPath: networkPath });
  const hqPort = await port();
  const hq = await createStation(resolveConfig({ role: 'headquarters', host: '127.0.0.1', port: hqPort, stationDir: 'hq', auth: { username: 'test', password: 'test-password' }, adapter: hqQueue, network: { id: 'image-network', stationId: 'hq', adapter: hqNetwork, heartbeatIntervalMs: 40, leaseDurationMs: 3000 }, registry: { storage: { id: 'headquarters-adapters', metadata: new MemoryRegistryMetadataAdapter(), blobs: new MemoryRegistryBlobAdapter() }, execution: { backend } }, runner: { pollIntervalMs: 20 } }), root);
  const key = await hq.keyStore!.create('worker catalog access', ['admin', 'read', 'trigger']);
  const active = new Map<string, Awaited<ReturnType<typeof createStation>>>(); active.set('hq', hq);
  t.after(async () => { for (const [id, station] of [...active].reverse()) { await station.stop(); active.delete(id); } });
  await hq.start();
  for (const id of ['worker-a', 'worker-b']) {
    const station = await createStation(resolveConfig({ role: 'station', host: '127.0.0.1', port: 0, stationDir: id, adapter: new SqliteAdapter({ dbPath: queuePath }), network: { id: 'image-network', stationId: id, adapter: new StationNetworkSqliteAdapter({ dbPath: networkPath }), heartbeatIntervalMs: 40, leaseDurationMs: 3000 }, runner: { pollIntervalMs: 20, maxConcurrent: 1 }, registry: { execution: { backend }, upstream: { url: `http://127.0.0.1:${hqPort}`, token: key.key, syncIntervalMs: 1000 } } }), root);
    active.set(id, station); await station.start();
  }
  const base = `http://127.0.0.1:${hqPort}/api/v1`, headers = { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' };
  async function api(path: string, body: unknown, method = 'POST') {
    const response = await fetch(`${base}${path}`, { method, headers, body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); return result.data;
  }
  const bytes = Buffer.from(`let t='';for await(const c of process.stdin)t+=c;const r=JSON.parse(t);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{request:r.input,runId:r.runId}}));`);
  const manifest = jsManifest('fleet/echo', bytes, [{ name: 'echo', kind: 'signal' }]);
  await api(`/registry/blobs/${manifest.artifacts[0]!.digest}`, bytes, 'PUT');
  const image: ImageRecord = await api('/registry/images', manifest);
  const name = imageSignalName(image.digest, 'echo');
  await waitFor(async () => { const stations = await hqNetwork.listStations({ networkId: 'image-network' }); return ['worker-a', 'worker-b'].every(id => stations.some(s => s.id === id && s.definitions.signals.includes(name))) ? true : undefined; }, 'workers automatically discovering late publication');
  for (const id of ['worker-a', 'worker-b']) assert.equal((await new FileImageRegistry(join(active.get(id)!.dataDir, 'registry')).getManifest(image.digest)).digest, image.digest);
  const invalidTarget = await fetch(`${base}/registry/run`, { method: 'POST', headers, body: JSON.stringify({ reference: image.digest, export: 'echo', input: {}, stationId: 'hq' }) });
  assert.equal(invalidTarget.status, 400); assert.equal((await invalidTarget.json()).error, 'unavailable_target');
  const first = await api('/registry/run', { reference: image.digest, export: 'echo', input: { round: 1 }, stationId: 'worker-a' });
  const firstRun = await waitFor(async () => { const value = await hqQueue.getRun(first.id); return value && ['completed', 'failed'].includes(value.status) ? value : undefined; }, 'first network image run');
  assert.equal(firstRun.status, 'completed', firstRun.error); assert.equal(firstRun.stationId, 'worker-a'); assert.equal(firstRun.requiredStationId, 'worker-a');
  assert.deepEqual(JSON.parse(firstRun.output!), { request: { round: 1 }, runId: first.id });
  const firstWorker = firstRun.stationId!; await active.get(firstWorker)!.stop(); active.delete(firstWorker);
  const second = await api('/registry/run', { reference: image.digest, export: 'echo', input: { round: 2 } });
  const secondRun = await waitFor(async () => { const value = await hqQueue.getRun(second.id); return value && ['completed', 'failed'].includes(value.status) ? value : undefined; }, 'remaining worker executing same Headquarters image');
  assert.equal(secondRun.status, 'completed', secondRun.error); assert.notEqual(secondRun.stationId, firstWorker); assert.notEqual(secondRun.stationId, 'hq');
  assert.deepEqual(JSON.parse(secondRun.output!), { request: { round: 2 }, runId: second.id });
});
