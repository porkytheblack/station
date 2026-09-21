import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalRunner, MemoryAdapter } from 'station-signal';
import { StationNetworkMemoryAdapter } from 'station-network';
import { FileImageRegistry } from 'station-images';
import { ImageController } from '../../src/images/controller.js';
import { ImagePreparations } from '../../src/images/preparation.js';
import type { ImageBackendConfig } from '../../src/images/runtime.js';
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64', abi: process.platform === 'linux' ? 'glibc' : 'none', runtimes: { node: Number(process.versions.node.split('.')[0]) } } };

test('catalog-only workers fetch pinned images on demand before execution, including generation bindings', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-cold-workers-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'headquarters'));
  const artifact = await registry.putBlob(Buffer.from(`let text='';for await(const part of process.stdin)text+=part;console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{input:JSON.parse(text).input,value:process.env.VALUE}}));`));
  const image = await registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'cold/echo', version: '1.0.0', artifacts: [{ ...artifact, platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 20, entrypoint: 'echo.mjs' }], exports: [{ name: 'echo', kind: 'signal' }] });
  const queue = new MemoryAdapter(), network = new StationNetworkMemoryAdapter();
  const headquarters = new ImageController({ registry, signalRunner: new SignalRunner({ adapter: queue, maxConcurrent: 0 }), backend, allowedEnv: ['VALUE'], stateDir: join(root, 'hq-runtime'), canTarget: async () => true });
  let deployment = await headquarters.stageDeployment('production', image.digest, undefined, undefined, { VALUE: { value: 'generation-value' } });
  deployment = await headquarters.changeDeployment(deployment.id, deployment.revision, 'activate', deployment.generations[0]!.id);
  const workers = [];
  for (const id of ['worker-a', 'worker-b']) {
    let downloads = 0;
    const workerRegistry = new FileImageRegistry(join(root, id, 'registry'));
    const runner = new SignalRunner({ adapter: queue, stationId: id, pollIntervalMs: 10, idlePollIntervalMs: 10, failUnknownSignals: false });
    const controller = new ImageController({ registry: workerRegistry, source: { resolve: r => registry.resolve(r), getBlob: async d => { downloads++; return registry.getBlob(d); } }, signalRunner: runner, stationId: id, backend, allowedEnv: ['VALUE'], stateDir: join(root, id, 'runtime'), preparation: { adapter: network, networkId: 'test', stationId: id } });
    await controller.sync([image]); await controller.syncGenerations(await headquarters.generations());
    assert.equal(downloads, 0); assert.equal(runner.listRegistered().length, 0, 'catalog advertisement does not install artifacts');
    assert.ok(controller.installableNames().length > 0);
    await assert.rejects(workerRegistry.getBlob(artifact.digest), { code: 'not_found' });
    workers.push({ controller, runner, loop: runner.start(), downloads: () => downloads, id });
  }
  try {
    for (const worker of workers) {
      const result = await headquarters.run(image.digest, 'echo', { worker: worker.id }, worker.id);
      const run = await worker.runner.waitForRun(result.id, { timeoutMs: 10000 });
      assert.equal(run?.status, 'completed', run?.error); assert.equal(run?.stationId, worker.id);
      assert.deepEqual(JSON.parse(run!.output!).input, { worker: worker.id }); assert.ok(worker.downloads() > 0);
    }
    const result = await headquarters.runDeployment(deployment.id, 'echo', {});
    const run = await workers[0]!.runner.waitForRun(result.id, { timeoutMs: 10000 });
    assert.equal(run?.status, 'completed', run?.error); assert.equal(JSON.parse(run!.output!).value, 'generation-value');
    assert.ok(workers.some(w => w.controller.preparations!.list().some(p => p.runId === result.id && p.state === 'ready')));
  } finally { for (const w of workers) { await w.controller.stop(); await w.runner.stop(); await w.loop; } }
});

test('preparation reservations serialize one run across workers and release after failures', async () => {
  const adapter = new StationNetworkMemoryAdapter();
  const a = new ImagePreparations({ adapter, networkId: 'test', stationId: 'a' });
  const b = new ImagePreparations({ adapter, networkId: 'test', stationId: 'b' });
  let release!: () => void, calls = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const run = { id: 'same-run', signalName: 'image' };
  await a.request(run, async owned => { calls++; assert.equal(await owned(), true); await blocked; throw new Error('download interrupted'); });
  await b.request(run, async () => { calls++; });
  assert.equal(calls, 1); release(); await a.stop();
  assert.equal(a.list()[0]!.state, 'failed');
  await b.request(run, async owned => { calls++; assert.equal(await owned(), true); });
  // Let preparation complete before asking stop to revoke admission.
  await new Promise(resolve => setTimeout(resolve, 0)); await b.stop();
  assert.equal(calls, 2); assert.equal(b.list()[0]!.state, 'ready');
});
