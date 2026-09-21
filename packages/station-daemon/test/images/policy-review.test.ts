import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileImageRegistry } from 'station-images';
import { SignalRunner, MemoryAdapter } from 'station-signal';
import { ImageController } from '../../src/images/controller.js';
import { cloneArtifactPolicy, type ImageBackendConfig } from '../../src/images/shim.js';
import { imageSignalName } from '../../src/images/runtime.js';
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64', runtimes: { node: Number(process.versions.node.split('.')[0]) } } };

test('artifact policy rejects malformed grants and controller snapshots retain initial denied grants', async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-policy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'registry'));
  const blob = await registry.putBlob(Buffer.from('console.log("hello")'));
  const image = await registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'tests/media', version: '1.0.0', artifacts: [{ ...blob, entrypoint: 'main.mjs', runtime: 'node', runtimeMajor: 22, platform: { os: 'any', arch: 'any' } }], exports: [{ name: 'run', kind: 'signal', artifacts: { write: true } }] });
  const key = `${image.digest}#run`, policy = { rootDir: join(root, 'media'), grants: { [key]: { write: false } } };
  for (const malformed of [ { ...policy, rootDir: './relative' }, { ...policy, grants: { [key]: { write: 'false' } } }, { ...policy, grants: { [key]: { readReferences: '/etc/passwd' } } }, { ...policy, maxStorageBytes: 0 } ]) assert.throws(() => cloneArtifactPolicy(malformed as any), { code: 'artifact_denied' });
  const runner = new SignalRunner({ adapter: new MemoryAdapter(), maxConcurrent: 0 });
  const controller = new ImageController({ registry, signalRunner: runner, backend, artifacts: policy, stateDir: join(root, 'state') });
  policy.grants[key]!.write = true;
  await assert.rejects(controller.install(image.digest), { code: 'artifact_denied' });
  const granted = new ImageController({ registry, signalRunner: runner, backend, artifacts: policy, stateDir: join(root, 'state-two') });
  policy.grants[key]!.write = false;
  assert.equal((await granted.install(image.digest)).image.digest, image.digest);
});

test('rollout renews authority before source mutation and after slow preparation before replacement/completion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-rollout-fence-')); t.after(() => rm(root, { recursive: true, force: true }));
  const digest = `sha256:${'a'.repeat(64)}` as const, generationId = '12345678-1234-1234-1234-123456789012';
  for (const phase of ['source', 'create', 'complete']) {
    let lease = phase !== 'source', mutations = 0, releases = 0;
    const source = { id: 'source', beaconName: 'old', desiredState: phase === 'source' ? 'running' : 'stopped', status: 'stopped' };
    const name = imageSignalName(digest, 'watch', { id: generationId });
    const adapter = {
      getInstance: async (id: string) => id === 'source' ? source : phase === 'complete' ? { beaconName: name, config: '{}', requiredStationId: undefined, readyAt: new Date(), status: 'running' } : undefined,
      updateInstance: async () => { mutations++; }, upsertInstance: async () => { mutations++; },
    };
    const controller = new ImageController({ registry: new FileImageRegistry(join(root, `registry-${phase}`)), signalRunner: new SignalRunner({ adapter: new MemoryAdapter(), maxConcurrent: 0 }), backend, stateDir: join(root, `state-${phase}`), beaconAdapter: adapter as any, rolloutCoordinator: {
      acquireControllerLease: async () => true, renewControllerLease: async () => lease, releaseControllerLease: async () => { releases++; return true; },
    } as any });
    (controller.deployments as any).list = async () => [{ id: 'deployment', generations: [{ id: generationId, image: { digest } }], rollouts: [{ id: 'operation', sourceInstance: 'source', sourceName: 'old', generation: generationId, export: 'watch', targetInstance: 'target', config: '{}' }] }];
    (controller.deployments as any).completeRollout = async () => { mutations++; };
    (controller as any).runtime.installGeneration = async () => { lease = false; return {}; };
    (controller as any).wire = async () => {};
    await assert.rejects(controller.reconcileRollouts(), { code: 'rollout_conflict' });
    assert.equal(mutations, 0, `lease loss before ${phase} forbids mutation`); assert.equal(releases, 1);
  }
});
