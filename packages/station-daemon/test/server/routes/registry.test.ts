import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { FileImageRegistry, digestBytes, type ImageManifest } from 'station-images';
import { imageRegistryRoutes } from '../../../src/server/routes/v1/registry.js';
import { registrySource } from '../../../src/registry/source.js';

test('registry API requires operator scope, verifies uploads, pins versions and imports a closure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'station-registry-api-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new FileImageRegistry(join(root, 'source'), { maxBlobBytes: 1024 });
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('authType', c.req.header('x-test-scope') ? 'api-key' : 'none'); c.set('scopes', [c.req.header('x-test-scope')]); await next(); });
  app.route('/', imageRegistryRoutes(registry));
  for (const scope of ['', 'execution', 'read', 'trigger']) assert.notEqual((await app.request('/registry/images', { headers: { 'x-test-scope': scope } })).status, 200);
  const headers = { 'x-test-scope': 'admin', 'content-type': 'application/json' };
  const blob = Buffer.from('compiled-artifact-fixture'); const digest = digestBytes(blob);
  assert.equal((await app.request(`/registry/blobs/${digest}`, { method: 'PUT', headers, body: blob })).status, 201);
  assert.equal((await app.request(`/registry/blobs/${digest}`, { method: 'PUT', headers, body: 'mismatch' })).status, 400);
  const manifest: ImageManifest = { format: 'station.image/v1', protocol: 'station.process/v1', name: 'test/echo', version: '1.0.0', exports: [{ name: 'echo', kind: 'signal' }], artifacts: [{ platform: { os: 'any', arch: 'any' }, runtime: 'node', runtimeMajor: 22, digest, size: blob.length, entrypoint: 'echo.mjs' }] };
  const result = await app.request('/registry/images', { method: 'POST', headers, body: JSON.stringify(manifest) }); assert.equal(result.status, 201);
  const { data: record } = await result.json();
  const resolved = await app.request('/registry/resolve?ref=test%2Fecho%401.0.0', { headers }); assert.deepEqual((await resolved.json()).data, record);
  assert.equal((await app.request('/registry/tags', { method: 'PUT', headers, body: JSON.stringify({ name: 'test/echo', tag: 'latest', digest: record.digest }) })).status, 200);
  assert.equal((await app.request(`/registry/blobs/${digest}`, { headers })).headers.get('cache-control'), 'private, no-store');
  const worker = new FileImageRegistry(join(root, 'worker')); const workerApp = new Hono();
  workerApp.use('*', async (c, next) => { c.set('authType', 'api-key'); c.set('scopes', ['admin']); await next(); });
  workerApp.route('/', imageRegistryRoutes(worker, { resolve: ref => registry.resolve(ref), getBlob: d => registry.getBlob(d) }));
  const pulled = await workerApp.request('/registry/pull', { method: 'POST', headers, body: JSON.stringify({ reference: 'test/echo@latest' }) });
  assert.equal(pulled.status, 201); assert.deepEqual(await worker.getBlob(digest), blob); assert.equal((await worker.resolve(record.digest)).digest, record.digest);
  assert.equal((await app.request(`/registry/blobs/${digest}`, { method: 'PUT', headers, body: Buffer.alloc(1025) })).status, 413);
});
test('registry upstream never accepts request-controlled destinations or plaintext remote credentials', () => {
  for (const url of ['http://example.com', 'https://example.com/other', 'https://user:secret@example.com', 'file:///tmp']) assert.throws(() => registrySource({ url, token: 'secret' }));
  assert.throws(() => registrySource({ url: 'https://example.com', token: 'bad\r\nheader' }));
});
