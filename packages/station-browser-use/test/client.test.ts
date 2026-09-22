import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { TestContext } from 'node:test';
import { BrowserUseClient, BrowserUseClientError } from '../src/client.js';

async function server(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const app = createServer(handle);
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { app.closeAllConnections(); app.close(() => resolve()); }));
  return `http://127.0.0.1:${(app.address() as { port: number }).port}`;
}
const isError = (code: string, status?: number, outcome?: 'unknown') => (error: unknown) => {
  assert.ok(error instanceof BrowserUseClientError);
  assert.equal(error.code, code); assert.equal(error.status, status); assert.equal(error.outcome, outcome);
  return true;
};

test('validates safe origins and owner paths without revealing configuration', () => {
  for (const baseUrl of ['http://example.com', 'ftp://example.com', 'https://token@example.com', 'https://example.com?q=token', 'https://example.com#token', 'https://example.com/api', 'https://example.com/a/../', 'https://example.com?', ' https://example.com', 'https://example.com\\evil']) {
    assert.throws(() => new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'token' }), isError('invalid_config'));
  }
  for (const baseUrl of ['https://example.com/', 'http://localhost:3210', 'http://127.0.0.1:3210/', 'http://[::1]:3210']) {
    const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'token' });
    assert.equal(JSON.stringify(client), '{}');
    assert.equal(Object.isFrozen(client), true);
  }
  for (const stationId of ['', '.', '..', '\ud800']) assert.throws(() => new BrowserUseClient({ baseUrl: 'https://example.com', stationId, apiKey: 'token' }), isError('invalid_config'));
  for (const timeoutMs of [0, -1, NaN, Infinity, 2 ** 31]) assert.throws(() => new BrowserUseClient({ baseUrl: 'https://example.com', stationId: 'worker', apiKey: 'token', timeoutMs }), isError('invalid_config'));
  assert.throws(() => new BrowserUseClient({ baseUrl: 'https://example.com', stationId: 'worker', apiKey: 'token\r\nInjected: yes' }), isError('invalid_config'));
});

test('posts authenticated owner RPC, unwraps data and snapshots mutable caller configuration', async t => {
  const requests: Array<{ path?: string; auth?: string; body: unknown }> = [];
  const baseUrl = await server(t, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) }); res.end(JSON.stringify({ data: { id: 'session-a' } })); });
  });
  const config = { baseUrl, stationId: 'worker/a', apiKey: 'original-key', timeoutMs: 1000 };
  const client = new BrowserUseClient(config);
  config.baseUrl = 'https://changed.invalid'; config.apiKey = 'changed-key'; config.stationId = 'changed';
  assert.deepEqual(await client.request({ method: 'open' }), { id: 'session-a' });
  const operator = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'admin-key', access: 'operator' });
  await operator.request({ method: 'list' });
  assert.deepEqual(requests, [
    { path: '/api/v1/tenant/stations/worker%2Fa/execution/browser', auth: 'Bearer original-key', body: { method: 'open' } },
    { path: '/api/v1/stations/worker/execution/browser', auth: 'Bearer admin-key', body: { method: 'list' } },
  ]);
});

test('does not follow redirects or forward a token to the redirect destination', async t => {
  let destinationRequests = 0, originRequests = 0;
  const destination = await server(t, (_req, res) => { destinationRequests++; res.end('{"data":null}'); });
  const baseUrl = await server(t, (_req, res) => { originRequests++; res.writeHead(307, { location: destination }); res.end(); });
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'secret' });
  await assert.rejects(client.request({ method: 'open' }), isError('redirect_refused', 307, 'unknown'));
  assert.equal(originRequests, 1); assert.equal(destinationRequests, 0);
});

test('preserves safe server codes and status but never forwards server messages or arbitrary codes', async t => {
  let count = 0;
  const baseUrl = await server(t, (_req, res) => { count++; res.statusCode = count === 1 ? 429 : 503; res.end(JSON.stringify({ error: count === 1 ? 'capacity' : 'my-secret-key', message: 'https://my-secret-key@private.invalid' })); });
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'my-secret-key' });
  await assert.rejects(client.request({ method: 'open' }), isError('capacity', 429));
  await assert.rejects(client.request({ method: 'open' }), error => {
    isError('http_error', 503, 'unknown')(error); assert.doesNotMatch(String(error), /secret|private/); return true;
  });
  assert.equal(count, 2);
});

test('malformed successful replies and disconnected operations have unknown outcomes with no retry', async t => {
  let count = 0;
  const baseUrl = await server(t, (req, res) => { count++; if (count === 1) res.end('{"unexpected":true}'); else req.socket.destroy(); });
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'secret' });
  await assert.rejects(client.request({ method: 'open' }), isError('invalid_response', 200, 'unknown'));
  await assert.rejects(client.request({ method: 'open' }), isError('network_error', undefined, 'unknown'));
  assert.equal(count, 2);
});

test('challenge and provider errors retain safe codes for agent decisions', async t => {
  const cases = [['challenge_required', 409], ['rate_limited', 429], ['provider_auth', 503], ['provider_capacity', 429], ['provider_unavailable', 503]] as const;
  let count = 0;
  const baseUrl = await server(t, (_req, res) => { const [error, status] = cases[count++]; res.statusCode = status; res.end(JSON.stringify({ error, message: 'PRIVATE-PROVIDER-KEY' })); });
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'key' });
  for (const [code, status] of cases) await assert.rejects(client.request({ method: 'open' }), error => {
    isError(code, status, status >= 500 ? 'unknown' : undefined)(error); assert.doesNotMatch(String(error), /PRIVATE-PROVIDER-KEY/); return true;
  });
  assert.equal(count, cases.length);
});

test('timeout applies while reading a response and cancellation after dispatch remains uncertain', async t => {
  let count = 0; let dispatched!: () => void;
  const arrived = new Promise<void>(resolve => { dispatched = resolve; });
  const baseUrl = await server(t, (_req, res) => { count++; res.writeHead(200); res.write('{"data":'); dispatched(); });
  const fast = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'secret', timeoutMs: 100 });
  await assert.rejects(fast.request({ method: 'open' }), isError('timeout', 200, 'unknown'));
  await arrived;
  const controller = new AbortController();
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'secret' });
  const pending = client.request({ method: 'open' }, { signal: controller.signal });
  while (count < 2) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort('secret cancellation reason');
  await assert.rejects(pending, error => { assert.ok(error instanceof BrowserUseClientError); assert.equal(error.code, 'cancelled'); assert.equal(error.outcome, 'unknown'); assert.doesNotMatch(String(error), /secret/); return true; });
  assert.equal(count, 2);
});

test('already aborted or unserializable input never dispatches', async t => {
  let count = 0;
  const baseUrl = await server(t, (_req, res) => { count++; res.end('{"data":null}'); });
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'secret' });
  await assert.rejects(client.request({ method: 'open' }, { signal: AbortSignal.abort('secret') }), isError('cancelled'));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(client.request(cyclic), isError('invalid_input'));
  assert.equal(count, 0);
});

test('accepts a large screenshot result but bounds declared and streamed oversized responses', async t => {
  let count = 0;
  const baseUrl = await server(t, (_req, res) => {
    count++;
    if (count === 1) return void res.end(JSON.stringify({ data: { base64: 'A'.repeat(17 * 1024 * 1024) } }));
    if (count === 2) { res.writeHead(200, { 'content-length': String(34 * 1024 * 1024) }); res.flushHeaders(); return; }
    const chunk = Buffer.alloc(1024 * 1024, 65); let sent = 0;
    const write = () => { while (sent++ < 34) if (!res.write(chunk)) { res.once('drain', write); return; } res.end(); };
    write();
  });
  const client = new BrowserUseClient({ baseUrl, stationId: 'worker', apiKey: 'secret', timeoutMs: 5000 });
  assert.equal((await client.request<{ base64: string }>({ method: 'recordingFrame' })).base64.length, 17 * 1024 * 1024);
  await assert.rejects(client.request({ method: 'open' }), isError('response_too_large', 200, 'unknown'));
  await assert.rejects(client.request({ method: 'open' }), isError('response_too_large', 200, 'unknown'));
  assert.equal(count, 3);
});
