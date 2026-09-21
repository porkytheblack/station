import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalRunner } from 'station-signal';
import { BeaconRunner, BeaconMemoryAdapter } from 'station-beacon';
import { StationNetworkMemoryAdapter } from 'station-network';
import { FileImageRegistry } from 'station-images';
import { ImageController } from '../../src/images/controller.js';
import type { ImageBackendConfig } from '../../src/images/runtime.js';
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve('tsx'));
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64', runtimes: { node: Number(process.versions.node.split('.')[0]) } } };
async function wait(check: () => Promise<boolean>) { const until = Date.now() + 10000; while (Date.now() < until) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('Beacon replacement timed out'); }

test('explicit beacon rollout retains old incarnation, rotates granted env and resumes durable replacement intent', { timeout: 25000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-rollout-')); t.after(() => rm(root, { force: true, recursive: true }));
  const registry = new FileImageRegistry(join(root, 'registry'));
  async function publish(version: string) {
    const artifact = await registry.putBlob(Buffer.from(`import{createInterface}from'node:readline';const send=o=>console.log(JSON.stringify({protocol:'station.process/v1',...o}));let timer;createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.type==='beacon:init'){send({type:'beacon:started'});if(process.env.TOKEN===${JSON.stringify(`secret-${version}`)})send({type:'beacon:ready'});timer=setInterval(()=>send({type:'beacon:heartbeat'}),40);}if(r.type==='beacon:stop'){clearInterval(timer);send({type:'beacon:stopped'});}});`));
    return registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'test/rotate', version, artifacts: [{ ...artifact, platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 20, entrypoint: 'watch.mjs' }], exports: [{ name: 'watch', kind: 'beacon', mode: 'run', requiredEnv: ['TOKEN'], configSchema: { type: 'object' } }] });
  }
  let secret = 'secret-1.0.0';
  const adapter = new BeaconMemoryAdapter(), network = new StationNetworkMemoryAdapter();
  const beaconRunner = new BeaconRunner({ adapter, pollIntervalMs: 20, envProvider: { resolveFor: async () => ({ SOURCE: secret }) } });
  const options = { registry, backend, signalRunner: new SignalRunner(), beaconRunner, beaconAdapter: adapter, rolloutCoordinator: network, stateDir: join(root, 'runtime'), allowedEnv: ['TOKEN', 'SOURCE'] };
  const controller = new ImageController(options);
  const first = await publish('1.0.0'), second = await publish('2.0.0');
  let deployment = await controller.stageDeployment('watcher', first.digest, undefined, undefined, { TOKEN: { fromEnv: 'SOURCE' } });
  deployment = await controller.changeDeployment(deployment.id, deployment.revision, 'activate', deployment.generations[0]!.id);
  const loop = beaconRunner.start(); await beaconRunner.whenReady();
  try {
    const old = await controller.runDeployment(deployment.id, 'watch', { scope: 'unchanged' });
    await wait(async () => Boolean((await adapter.getInstance(old.id))?.readyAt));
    const oldIncarnation = (await adapter.getInstance(old.id))!.incarnation;
    secret = 'secret-2.0.0';
    deployment = await controller.stageDeployment('watcher', second.digest, undefined, undefined, { TOKEN: { fromEnv: 'SOURCE' } });
    const generation = deployment.generations[1]!.id;
    deployment = await controller.changeDeployment(deployment.id, deployment.revision, 'activate', generation);
    assert.equal((await adapter.getInstance(old.id))?.incarnation, oldIncarnation);
    const request = { operationId: 'upgrade-2', expectedRevision: deployment.revision, sourceInstance: old.id, generation, alias: 'watch' };
    const rollout = await controller.rolloutBeacon(deployment.id, request);
    // Reconstruct the controller before completion; replacement intent is on disk.
    const restored = new ImageController(options); await restored.restore();
    await wait(async () => { await restored.reconcileRollouts(); return Boolean((await restored.deployments.get(deployment.id)).rollouts?.[0]?.completedAt); });
    const previous = (await adapter.getInstance(old.id))!, replacement = (await adapter.getInstance(rollout.targetInstance))!;
    assert.equal(previous.status, 'stopped'); assert.equal(previous.incarnation, oldIncarnation);
    assert.equal(replacement.status, 'running'); assert.ok(replacement.readyAt); assert.notEqual(previous.beaconName, replacement.beaconName);
    assert.equal(replacement.config, previous.config);
    const retry = await restored.rolloutBeacon(deployment.id, request); assert.equal(retry.targetInstance, rollout.targetInstance);
    assert.equal((await adapter.listInstances()).length, 2, 'retry never creates another replacement');
    assert.ok(!JSON.stringify(await restored.deployments.list()).includes('secret-2.0.0'));
  } finally { await beaconRunner.stop({ graceful: true, timeoutMs: 5000 }); await loop; }
});
