import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { registryProxyRoutes } from '../../../src/registry/proxy.js';

test('Headquarters private registry proxy pins identity and preserves binary requests without exposing credentials', async t => {
  const calls: { path: string; authorization: string | null; bytes: Uint8Array }[] = [];
  let actualId = 'worker-a';
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    assert.equal(request.headers.get('authorization'), 'Bearer private-worker-key');
    if (path === '/api/v1/info') return Response.json({ data: { protocol: 'station.api/v1', version: '3.0.0', stationId: actualId } });
    const bytes = new Uint8Array(await request.arrayBuffer()); calls.push({ path, authorization: request.headers.get('authorization'), bytes });
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'set-cookie': 'must-not-forward=secret' } });
  } });
  if (!server.listening) await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections?.(); server.close(error => error ? reject(error) : resolve()); }));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('authType', 'api-key'); c.set('scopes', [c.req.header('x-scope')]); await next(); });
  app.route('/', registryProxyRoutes({ 'worker-a': { url: `http://127.0.0.1:${address.port}`, token: 'private-worker-key' } }));
  const path = '/stations/worker-a/registry/blobs/sha256:' + 'a'.repeat(64);
  assert.equal((await app.request(path, { headers: { 'x-scope': 'read' } })).status, 403); assert.equal(calls.length, 0);
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const response = await app.request(path, { method: 'PUT', headers: { 'x-scope': 'admin', authorization: 'Bearer caller-key' }, body: bytes });
  assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.path, '/api/v1/registry/blobs/sha256:' + 'a'.repeat(64));
  actualId = 'unexpected-worker';
  assert.equal((await app.request(path, { method: 'PUT', headers: { 'x-scope': 'admin' }, body: bytes })).status, 502); assert.equal(calls.length, 1, 'identity mismatch prevents mutation');
  assert.equal((await app.request('/stations/unconfigured/registry/images', { headers: { 'x-scope': 'admin' } })).status, 404);
  assert.throws(() => registryProxyRoutes({ worker: { url: 'http://remote.example', token: 'x' } }), /HTTPS/);
});
