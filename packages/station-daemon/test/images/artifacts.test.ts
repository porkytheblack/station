import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalRunner } from 'station-signal';
import { FileImageRegistry, FileInvocationArtifactStore } from 'station-images';
import { ImageController } from '../../src/images/controller.js';
import type { ImageBackendConfig } from '../../src/images/runtime.js';
const backend: ImageBackendConfig = { kind: 'trusted-local', allowUnsafeHostExecution: true, target: { os: process.platform as 'linux' | 'darwin', arch: process.arch === 'arm64' ? 'arm64' : 'amd64', runtimes: { node: Number(process.versions.node.split('.')[0]) } } };

test('daemon image shims broker media through explicit export and invocation capabilities', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-daemon-media-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'registry')), rootDir = join(root, 'media');
  const bytes = Buffer.from(`import{createInterface}from'node:readline';import{createHash}from'node:crypto';
const lines=createInterface({input:process.stdin}),pending=new Map();let n=0;
const send=f=>console.log(JSON.stringify({protocol:'station.process/v1',...f}));
const call=(operation,fields)=>new Promise(resolve=>{const id='q'+(++n);pending.set(id,resolve);send({type:'artifact:request',id,operation,...fields});});
lines.on('line',async line=>{const r=JSON.parse(line);if(r.type==='artifact:response'){pending.get(r.id)?.(r.result);pending.delete(r.id);return;}
if(r.export==='write'){const data=Buffer.alloc(5*1024*1024+17,65);const a=await call('create',{size:data.length,digest:'sha256:'+createHash('sha256').update(data).digest('hex')});for(let offset=0;offset<data.length;offset+=r.artifacts.maxChunkBytes)await call('append',{reference:a.reference,offset,data:data.subarray(offset,offset+r.artifacts.maxChunkBytes).toString('base64')});send({type:'result',output:await call('commit',{reference:a.reference})});}
else send({type:'result',output:await call('read',{reference:r.input.reference,offset:0,length:8})});lines.close();process.stdin.destroy();});`);
  const artifact = await registry.putBlob(bytes);
  const image = await registry.publish({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'test/media', version: '1.0.0', artifacts: [{ ...artifact, platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 22, entrypoint: 'media.mjs' }], exports: [{ name: 'write', kind: 'signal', artifacts: { write: true } }, { name: 'read', kind: 'signal', artifacts: { read: true } }] });
  const runner = new SignalRunner({ pollIntervalMs: 10 });
  const denied = new ImageController({ registry, backend, signalRunner: runner, stateDir: join(root, 'denied') });
  await assert.rejects(denied.install(image.digest), { code: 'artifact_denied' });
  const policy = { rootDir, maxBytes: 6 * 1024 * 1024, grants: { [`${image.digest}#write`]: { write: true }, [`${image.digest}#read`]: { readReferences: [] as string[] } } };
  const writer = new ImageController({ registry, backend, signalRunner: runner, stateDir: join(root, 'writer'), artifacts: policy });
  const loop = runner.start();
  let reference: string;
  try {
    const invocation = await writer.run(image.digest, 'write', {});
    const run = await runner.waitForRun(invocation.id, { timeoutMs: 10000 }); assert.equal(run?.status, 'completed', run?.error);
    const result = JSON.parse(run!.output!); reference = result.reference;
    assert.equal((await new FileInvocationArtifactStore({ rootDir }).describe(reference)).size, 5 * 1024 * 1024 + 17);
    const deniedRead = await writer.run(image.digest, 'read', { reference });
    assert.equal((await runner.waitForRun(deniedRead.id, { timeoutMs: 10000 }))?.status, 'failed', 'business input cannot grant its own artifact reference');
  } finally { await runner.stop(); await loop; }
  const readerRunner = new SignalRunner({ pollIntervalMs: 10 });
  const reader = new ImageController({ registry, backend, signalRunner: readerRunner, stateDir: join(root, 'reader'), artifacts: { ...policy, grants: { ...policy.grants, [`${image.digest}#read`]: { readReferences: [reference!] } } } });
  const readerLoop = readerRunner.start();
  try {
    const invocation = await reader.run(image.digest, 'read', { reference: reference! });
    const run = await readerRunner.waitForRun(invocation.id, { timeoutMs: 10000 }); assert.equal(run?.status, 'completed', run?.error);
    assert.equal(Buffer.from(JSON.parse(run!.output!).data, 'base64').toString(), 'AAAAAAAA');
  } finally { await readerRunner.stop(); await readerLoop; }
});
