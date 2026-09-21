import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BeaconRunner, BeaconMemoryAdapter } from 'station-beacon';
import { SignalRunner } from 'station-signal';
import { StationNetworkMemoryAdapter } from 'station-network';
import { FileImageRegistry } from 'station-images';
import { ImageController } from '../../src/images/controller.js';
import type { ImageBackendConfig } from '../../src/images/runtime.js';
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve('tsx'));
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64', runtimes: { node: Number(process.versions.node.split('.')[0]) } } };
async function wait(read: () => Promise<boolean>) { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await read()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Beacon ownership/readiness timed out'); }

test('Headquarters image beacon intent starts only on its selected worker and installation creates no replicas', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'image-beacon-network-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'registry'));
  const artifact = await registry.putBlob(Buffer.from(`import{createInterface}from'node:readline';const send=o=>console.log(JSON.stringify({protocol:'station.process/v1',...o}));let timer;createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type==='beacon:init'){send({type:'beacon:started'});send({type:'beacon:ready'});timer=setInterval(()=>send({type:'beacon:heartbeat'}),50);}if(r.type==='beacon:stop'){clearInterval(timer);send({type:'beacon:stopped'});}});`));
  const image = await registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'network/watch', version: '1.0.0', artifacts: [{ ...artifact, platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 20, entrypoint: 'watch.mjs' }], exports: [{ name: 'watch', kind: 'beacon', mode: 'run', startMode: 'auto', configSchema: { type: 'object' } }] });
  const adapter = new BeaconMemoryAdapter();
  const networkCoordinator = new StationNetworkMemoryAdapter();
  const workers = [];
  for (const stationId of ['a', 'b']) {
    const beaconRunner = new BeaconRunner({ adapter, stationId, pollIntervalMs: 20, networkCoordinator });
    const controller = new ImageController({ registry, backend, signalRunner: new SignalRunner(), beaconRunner, stationId, stateDir: join(root, stationId) });
    await controller.install(image.digest); const loop = beaconRunner.start(); await beaconRunner.whenReady(); workers.push({ beaconRunner, loop, controller, stationId });
  }
  try {
    assert.equal((await adapter.listInstances()).length, 0, 'even an auto manifest does not start a replica per worker');
    const hq = new ImageController({ registry, backend, beaconAdapter: adapter, signalRunner: new SignalRunner(), stateDir: join(root, 'headquarters'), canTarget: async id => id === 'a' || id === 'b' });
    const result = await hq.run(image.digest, 'watch', { purpose: 'owner test' }, 'b');
    await wait(async () => Boolean((await adapter.getInstance(result.id))?.readyAt));
    const instance = await adapter.getInstance(result.id); assert.equal(instance?.stationId, 'b'); assert.equal(instance?.requiredStationId, 'b');
    assert.equal((await adapter.listInstances()).length, 1);
    await workers[1]!.beaconRunner.stopInstance(result.id);
    await wait(async () => (await adapter.getInstance(result.id))?.status === 'stopped');
  } finally { for (const worker of workers) { await worker.beaconRunner.stop({ graceful: true, timeoutMs: 5000 }); await worker.loop; } }
});
