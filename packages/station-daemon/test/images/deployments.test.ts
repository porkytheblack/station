import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalRunner, MemoryAdapter } from 'station-signal';
import { FileImageRegistry } from 'station-images';
import { ImageController } from '../../src/images/controller.js';
import { FileImageDeploymentStorage, ImageDeployments } from '../../src/images/deployments.js';
import { imageSignalName, type ImageBackendConfig } from '../../src/images/runtime.js';
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64', abi: process.platform === 'linux' ? 'glibc' : 'none', runtimes: { node: Number(process.versions.node.split('.')[0]) } } };

test('staging, activation, update, rollback and recovery preserve queued image identities', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-deployments-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'registry'));
  const publish = async (version: string) => {
    const artifact = await registry.putBlob(Buffer.from(`let text='';for await(const p of process.stdin)text+=p;const request=JSON.parse(text);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{version:${JSON.stringify(version)},input:request.input}}));`));
    return registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'test/application', version, artifacts: [{ ...artifact, platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 20, entrypoint: 'app.mjs' }], exports: [{ name: 'echo', kind: 'signal' }] });
  };
  const first = await publish('1.0.0'), second = await publish('2.0.0');
  const adapter = new MemoryAdapter();
  const runner = new SignalRunner({ pollIntervalMs: 10, adapter });
  const options = { registry, signalRunner: runner, backend, stateDir: join(root, 'runtime') };
  const controller = new ImageController(options);
  let deployment = await controller.stageDeployment('production', first.digest, { current: 'echo' });
  assert.equal(runner.hasSignal(imageSignalName(first.digest, 'echo')), false, 'staging exposes no runnable definition');
  await assert.rejects(controller.runDeployment(deployment.id, 'current', {}), { code: 'deployment_inactive' });
  const firstGeneration = deployment.generations[0]!.id;
  deployment = await controller.changeDeployment(deployment.id, deployment.revision, 'activate', firstGeneration);
  const oldRun = await controller.runDeployment(deployment.id, 'current', { queued: 'before update' });
  deployment = await controller.stageDeployment('production', second.digest, { current: 'echo' });
  const secondGeneration = deployment.generations[1]!.id;
  assert.equal(deployment.activeGeneration, firstGeneration);
  await assert.rejects(controller.changeDeployment(deployment.id, deployment.revision, 'rollback', secondGeneration), { code: 'invalid_rollback' });
  deployment = await controller.changeDeployment(deployment.id, deployment.revision, 'activate', secondGeneration);
  const newRun = await controller.runDeployment(deployment.id, 'current', { queued: 'after update' });
  await assert.rejects(controller.changeDeployment(deployment.id, deployment.revision - 1, 'activate', firstGeneration), { code: 'revision_conflict' });
  deployment = await controller.changeDeployment(deployment.id, deployment.revision, 'rollback', firstGeneration);
  const restoredRunner = new SignalRunner({ pollIntervalMs: 10, adapter });
  const restoredController = new ImageController({ ...options, signalRunner: restoredRunner }); await restoredController.restore();
  assert.equal((await restoredController.deployments.get(deployment.id)).activeGeneration, firstGeneration);
  const rolledBack = await restoredController.runDeployment(deployment.id, 'current', {});
  const loop = restoredRunner.start();
  try {
    for (const [result, version, generation] of [[oldRun, '1.0.0', firstGeneration], [newRun, '2.0.0', secondGeneration], [rolledBack, '1.0.0', firstGeneration]] as const) {
      const run = await restoredRunner.waitForRun(result.id, { timeoutMs: 10000 });
      assert.equal(run?.status, 'completed', run?.error); assert.equal(JSON.parse(run!.output!).version, version); assert.equal(result.generation, generation);
    }
  } finally { await restoredRunner.stop(); await loop; }
  deployment = await restoredController.changeDeployment(deployment.id, deployment.revision, 'drain');
  await assert.rejects(restoredController.runDeployment(deployment.id, 'current', {}), { code: 'deployment_inactive' });
  assert.equal(deployment.generations.length, 2, 'drain retains history and queued/recovery artifacts');
  const changedNamespace = new ImageDeployments(new FileImageDeploymentStorage(join(root, 'runtime', 'deployments.json')), 'different-registry');
  await assert.rejects(changedNamespace.list(), { code: 'incompatible_state' });
});

test('deployment storage atomically rejects stale writers and retains committed state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-deployment-cas-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileImageDeploymentStorage(join(root, 'state.json'));
  const initial = { format: 'station.deployments/v1' as const, identity: 'registry', revision: 1, deployments: [] };
  assert.equal(await store.compareAndSwap(0, initial), true);
  assert.equal(await store.compareAndSwap(0, { ...initial, identity: 'wrong' }), false);
  assert.deepEqual(await store.read(), initial);
});

test('generation environment references stay out of persistent artifacts and execute with independent bindings', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-deployment-env-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'registry'));
  const bytes = Buffer.from(`for await(const x of process.stdin){};console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{value:process.env.VALUE,denied:process.env.UNGRANTED??null}}));`);
  const artifact = await registry.putBlob(bytes);
  const image = await registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'test/env', version: '1.0.0', artifacts: [{ ...artifact, platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 20, entrypoint: 'env.mjs' }], exports: [{ name: 'read', kind: 'signal', requiredEnv: ['VALUE'] }] });
  const runner = new SignalRunner({ pollIntervalMs: 10, envProvider: { resolveFor: async () => ({ SECRET_SOURCE: 'runtime-only-secret', VALUE: 'store-value', UNGRANTED: 'never' }) } });
  const controller = new ImageController({ registry, signalRunner: runner, backend, stateDir: join(root, 'runtime'), allowedEnv: ['VALUE', 'SECRET_SOURCE'] });
  await assert.rejects(controller.stageDeployment('denied', image.digest, undefined, undefined, { NODE_OPTIONS: { value: 'unsafe' } }), { code: 'environment_denied' });
  await assert.rejects(controller.stageDeployment('denied', image.digest, undefined, undefined, { VALUE: { fromEnv: 'UNGRANTED' } }), { code: 'environment_denied' });
  const first = await controller.stageDeployment('secret', image.digest, undefined, undefined, { VALUE: { fromEnv: 'SECRET_SOURCE' } });
  const second = await controller.stageDeployment('literal', image.digest, undefined, undefined, { VALUE: { value: 'nonsecret-config' } }, ['VALUE']);
  for (const d of [first, second]) await controller.changeDeployment(d.id, d.revision, 'activate', d.generations[0]!.id);
  const one = await controller.runDeployment(first.id, 'read', {}), two = await controller.runDeployment(second.id, 'read', {});
  await assert.rejects(controller.runDeployment(first.id, 'read', {}, { VALUE: { value: 'denied' } }), { code: 'environment_denied' });
  const overridden = await controller.runDeployment(second.id, 'read', {}, { VALUE: { value: 'invocation-only' } });
  assert.notEqual(overridden.generation, two.generation);
  const audited = await controller.deployments.get(second.id);
  assert.equal(audited.activeGeneration, two.generation); assert.equal(audited.history.at(-1)?.action, 'invoke');
  assert.equal(audited.generations.at(-1)?.sourceGeneration, two.generation);
  assert.notEqual(one.registeredName, two.registeredName);
  await assert.rejects(controller.syncGenerations([{ digest: image.digest, generation: { id: first.generations[0]!.id, bindings: { VALUE: { value: 'must-not-replace-queued-binding' } } } }]), { code: 'immutable_conflict' });
  assert.ok(!JSON.stringify(await controller.deployments.list()).includes('runtime-only-secret'));
  const loop = runner.start();
  try {
    for (const [run, expected] of [[one, 'runtime-only-secret'], [two, 'nonsecret-config'], [overridden, 'invocation-only']] as const) {
      const done = await runner.waitForRun(run.id, { timeoutMs: 10000 }); assert.equal(done?.status, 'completed', done?.error);
      assert.deepEqual(JSON.parse(done!.output!), { value: expected, denied: null });
    }
  } finally { await runner.stop(); await loop; }
  const workerRunner = new SignalRunner();
  const worker = new ImageController({ registry, signalRunner: workerRunner, backend, stateDir: join(root, 'other-worker'), allowedEnv: ['VALUE', 'SECRET_SOURCE'] });
  await worker.syncGenerations(await controller.generations());
  assert.ok(workerRunner.hasSignal(one.registeredName)); assert.ok(workerRunner.hasSignal(two.registeredName));
  assert.ok(workerRunner.hasSignal(overridden.registeredName));
});
