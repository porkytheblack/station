import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileInvocationArtifactStore, type InvocationArtifactScope } from '../src/artifacts.js';
import { FileImageRegistry, digestBytes, executeImage, startImageBeacon, TrustedLocalProcessBackend, validateManifest, type ImageManifest, type HostTarget } from '../src/index.js';
const protocol = 'station.process/v1'; let sequence = 0;
const frame = (operation: string, fields: Record<string, unknown>) => ({ protocol, type: 'artifact:request', id: `q${++sequence}`, operation, ...fields });
async function request(scope: InvocationArtifactScope, operation: string, fields: Record<string, unknown>): Promise<any> { return (await scope.handle(frame(operation, fields))).result; }
async function fixture(t: TestContext, limits: { maxStorageBytes?: number; maxStoredArtifacts?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'station-artifacts-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new FileInvocationArtifactStore({ rootDir: directory, ...limits }) };
}
async function put(scope: InvocationArtifactScope, bytes: Buffer) {
  const created = await request(scope, 'create', { size: bytes.length, digest: digestBytes(bytes) });
  for (let offset = 0; offset < bytes.length; offset += scope.maxChunkBytes) await request(scope, 'append', { reference: created.reference, offset, data: bytes.subarray(offset, offset + scope.maxChunkBytes).toString('base64') });
  return request(scope, 'commit', { reference: created.reference });
}
async function image(t: TestContext, source: string, kind: 'signal' | 'beacon' = 'signal') {
  const { directory } = await fixture(t); const registry = new FileImageRegistry(directory); const bytes = Buffer.from(source);
  await registry.putBlob(bytes);
  const manifest: ImageManifest = { format: 'station.image/v1', protocol, name: 'tests/artifacts', version: '1.0.0', artifacts: [{ platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 22, entrypoint: 'run.mjs', digest: digestBytes(bytes), size: bytes.length }], exports: [{ name: 'work', kind, ...(kind === 'beacon' ? { mode: 'run', startMode: 'on-demand' } : {}), artifacts: { read: true, write: true } }] };
  const record = await registry.publish(manifest);
  const target: HostTarget = { os: process.platform as HostTarget['os'], arch: process.arch === 'arm64' ? 'arm64' : 'amd64', runtimes: { node: Number(process.versions.node.split('.')[0]) } };
  return { registry, reference: record.digest, exportName: 'work', backend: new TrustedLocalProcessBackend({ allowUnsafeHostExecution: true, target }), requiredIsolation: 'trusted-host' as const };
}
const client = `import {createInterface} from 'node:readline'; import {createHash} from 'node:crypto';
const lines=createInterface({input:process.stdin}); const pending=new Map(); let next=0;
function send(frame){console.log(JSON.stringify({protocol:'station.process/v1',...frame}));}
function call(operation,fields){const id='r'+(++next); return new Promise(resolve=>{pending.set(id,resolve);send({type:'artifact:request',id,operation,...fields});});}
lines.on('line',async line=>{const req=JSON.parse(line);if(req.type==='artifact:response'){pending.get(req.id)?.(req.result);pending.delete(req.id);return;} await run(req);});`;

test('real process transfers media larger than normal protocol output budget in bounded chunks', async t => {
  const { store } = await fixture(t); const size = 5 * 1024 * 1024 + 17;
  const bytes = Buffer.alloc(size, 73), digest = digestBytes(bytes);
  const options = await image(t, client + `async function run(req){const bytes=Buffer.alloc(req.input.size,73);const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');const upload=await call('create',{size:bytes.length,digest});for(let offset=0;offset<bytes.length;offset+=req.artifacts.maxChunkBytes)await call('append',{reference:upload.reference,offset,data:bytes.subarray(offset,offset+req.artifacts.maxChunkBytes).toString('base64')});const result=await call('commit',{reference:upload.reference});send({type:'result',output:result});lines.close();process.stdin.destroy();}`);
  const writer = await store.scope({ invocationId: 'run-a:1', permissions: { write: true }, maxBytes: 6 * 1024 * 1024 });
  const result = await executeImage({ ...options, runId: 'run-a', input: { size }, artifacts: writer });
  const reference = (result.output as any).reference;
  assert.equal((result.output as any).digest, digest); assert.equal((result.output as any).size, size);
  await assert.rejects(writer.handle(frame('create', { size: 0, digest: digestBytes('') })), /closed/);
  const restarted = new FileInvocationArtifactStore({ rootDir: store.rootDir });
  const reader = await restarted.scope({ invocationId: 'run-b:1', permissions: { read: true }, readReferences: [reference], maxBytes: 6 * 1024 * 1024 });
  const chunks: Buffer[] = []; for (let offset = 0; offset < size; offset += reader.maxChunkBytes) chunks.push(Buffer.from((await request(reader, 'read', { reference, offset, length: Math.min(reader.maxChunkBytes, size - offset) })).data, 'base64'));
  assert.deepEqual(Buffer.concat(chunks), bytes); await reader.close();
});

test('references require an explicit invocation grant and cannot cross a tenant store', async t => {
  const { store } = await fixture(t); const other = await fixture(t);
  const writer = await store.scope({ invocationId: 'one', permissions: { write: true } }); const record = await put(writer, Buffer.from('private media')); await writer.close();
  const denied = await store.scope({ invocationId: 'two', permissions: { read: true } });
  await assert.rejects(request(denied, 'read', { reference: record.reference, offset: 0, length: 1 }), { code: 'artifact_denied' });
  await assert.rejects(other.store.scope({ invocationId: 'foreign', permissions: { read: true }, readReferences: [record.reference] }), { code: 'artifact_denied' });
  await assert.rejects(request(denied, 'read', { reference: '../../etc/passwd', offset: 0, length: 1 }), { code: 'artifact_denied' });
  await denied.close();
  await writeFile(join(store.rootDir, record.reference.split(':')[1], 'data'), 'tampered data');
  await assert.rejects(store.scope({ invocationId: 'three', permissions: { read: true }, readReferences: [record.reference] }), { code: 'artifact_corrupt' });
});

test('global durable reservations bound concurrent clients, survive restart and reclaim on close/expiry', async t => {
  const { store, directory } = await fixture(t, { maxStorageBytes: 4, maxStoredArtifacts: 2 });
  const second = new FileInvocationArtifactStore({ rootDir: directory, maxStorageBytes: 4, maxStoredArtifacts: 2 });
  const a = await store.scope({ invocationId: 'a', permissions: { write: true }, ttlMs: 1000 });
  const b = await second.scope({ invocationId: 'b', permissions: { write: true } });
  const results = await Promise.allSettled([request(a, 'create', { size: 4, digest: digestBytes('1234') }), request(b, 'create', { size: 4, digest: digestBytes('1234') })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult; assert.equal(failed.reason.code, 'artifact_store_limit');
  await a.close(); await b.close();
  const committed = await second.scope({ invocationId: 'committed', permissions: { write: true }, ttlMs: 1000 });
  const record = await put(committed, Buffer.from('1234')); await committed.close();
  const restarted = new FileInvocationArtifactStore({ rootDir: directory, maxStorageBytes: 4 });
  const another = await restarted.scope({ invocationId: 'next', permissions: { write: true } });
  await assert.rejects(request(another, 'create', { size: 1, digest: digestBytes('x') }), { code: 'artifact_store_limit' });
  await new Promise(r => setTimeout(r, 1050));
  assert.equal(await restarted.reapExpired(), 1); await assert.rejects(restarted.describe(record.reference), { code: 'artifact_denied' });
  await request(another, 'create', { size: 1, digest: digestBytes('x') }); await another.close();
  assert.deepEqual((await readdir(directory)).sort(), ['store.json']);
});

test('offset/digest/declaration checks reject malformed writes and cleanup incomplete files', async t => {
  const { store } = await fixture(t); const scope = await store.scope({ invocationId: 'one', permissions: { write: true }, maxBytes: 3, maxChunkBytes: 2 });
  const uploaded = await request(scope, 'create', { size: 3, digest: digestBytes('abc') });
  await assert.rejects(request(scope, 'append', { reference: uploaded.reference, offset: 1, data: 'YQ==' }), { code: 'artifact_chunk' });
  await assert.rejects(request(scope, 'append', { reference: uploaded.reference, offset: 0, data: 'YWJj' }), { code: 'artifact_limit' });
  await request(scope, 'append', { reference: uploaded.reference, offset: 0, data: 'eHg=' });
  await request(scope, 'append', { reference: uploaded.reference, offset: 2, data: 'eA==' });
  await assert.rejects(request(scope, 'commit', { reference: uploaded.reference }), { code: 'artifact_digest' }); await scope.close();
  assert.deepEqual((await readdir(store.rootDir)).sort(), ['store.json']);
  const options = await image(t, client + `async function run(){}`);
  const manifest = (await options.registry.resolve(options.reference)).manifest;
  assert.throws(() => validateManifest({ ...manifest, exports: [{ ...manifest.exports[0], artifacts: { read: 'yes' } }] }), { code: 'invalid_manifest' });
  const noDeclaration = await options.registry.publish({ ...manifest, version: '2.0.0', exports: [{ name: 'work', kind: 'signal' }] });
  const granted = await store.scope({ invocationId: 'denied', permissions: { write: true } });
  await assert.rejects(executeImage({ ...options, reference: noDeclaration.digest, input: {}, runId: 'denied', artifacts: granted }), { code: 'artifact_denied' }); await granted.close();
});

test('beacon incarnation supports artifact writes and closes its capability on stop', async t => {
  const { store } = await fixture(t);
  const options = await image(t, client + `async function run(req){if(req.type==='beacon:init'){send({type:'beacon:started'});const digest='sha256:'+createHash('sha256').update('beacon').digest('hex');const upload=await call('create',{size:6,digest});await call('append',{reference:upload.reference,offset:0,data:Buffer.from('beacon').toString('base64')});await call('commit',{reference:upload.reference});send({type:'beacon:ready'});}if(req.type==='beacon:stop'){send({type:'beacon:stopped'});lines.close();process.stdin.destroy();}}`, 'beacon');
  const scope = await store.scope({ invocationId: 'instance:incarnation', permissions: { write: true } });
  const session = await startImageBeacon({ ...options, instanceId: 'instance', incarnation: 'one', config: {}, artifacts: scope });
  await session.ready; await session.stop(); await session.done;
  await assert.rejects(scope.handle(frame('create', { size: 0, digest: digestBytes('') })), /closed/);
  assert.equal((await readdir(store.rootDir)).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 1);
});

test('deadline closes scope and releases a process-created incomplete upload reservation', async t => {
  const { store } = await fixture(t, { maxStorageBytes: 4 });
  const options = await image(t, client + `async function run(){await call('create',{size:4,digest:'sha256:'+createHash('sha256').update('1234').digest('hex')});setInterval(()=>{},1000);}`);
  const scope = await store.scope({ invocationId: 'timed-out', permissions: { write: true } });
  await assert.rejects(executeImage({ ...options, runId: 'timed-out', input: {}, timeoutMs: 700, artifacts: scope }), { code: 'timeout' });
  assert.deepEqual((await readdir(store.rootDir)).sort(), ['store.json']);
  const next = await store.scope({ invocationId: 'next', permissions: { write: true } });
  await put(next, Buffer.from('1234')); await next.close();
});
