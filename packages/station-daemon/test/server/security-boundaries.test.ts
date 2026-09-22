import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { rateLimiter, validateTrustedProxies } from '../../src/server/middleware/rate-limit.js';
import { resolveConfig } from '../../src/config/schema.js';
import { v1AuthRoutes } from '../../src/server/routes/v1/auth.js';

test('only explicitly trusted proxy hops can affect client rate buckets', async () => {
  const make = (trustedProxies: string[] = []) => {
    const app = new Hono(); app.use('*', rateLimiter({ max: 1, trustedProxies })); app.get('/', c => c.text('ok')); return app;
  };
  const request = (app: Hono, peer: string, forwarded: string) => app.request('/', { headers: { 'x-forwarded-for': forwarded } }, { incoming: { socket: { remoteAddress: peer } } });
  const direct = make();
  assert.equal((await request(direct, '192.0.2.1', '198.51.100.1')).status, 200);
  assert.equal((await request(direct, '192.0.2.1', '198.51.100.2')).status, 429);
  const proxy = make(['192.0.2.10', '192.0.2.11']);
  assert.equal((await request(proxy, '::ffff:192.0.2.10', '198.51.100.1, 192.0.2.11')).status, 200);
  assert.equal((await request(proxy, '192.0.2.10', '198.51.100.2, 192.0.2.11')).status, 200);
  assert.equal((await request(proxy, '192.0.2.10', '203.0.113.55, 198.51.100.1, 192.0.2.11')).status, 429);
  assert.equal((await request(proxy, '192.0.2.10', 'malformed')).status, 200);
  assert.equal((await request(proxy, '192.0.2.10', 'another malformed')).status, 429);
  assert.throws(() => validateTrustedProxies(['*']), /exact ingress/);
});

test('login and logout cookies default Secure regardless of spoofed forwarding headers', async () => {
  const password = randomBytes(24).toString('hex');
  for (const secureCookies of [undefined, true, false]) {
    const app = v1AuthRoutes({ sessionConfig: { username: 'test', password, secureCookies } });
    const login = await app.request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'http' }, body: JSON.stringify({ username: 'test', password }) });
    assert.equal(login.status, 200);
    const logout = await app.request('/auth/logout', { method: 'POST' });
    for (const response of [login, logout]) {
      assert.equal(response.headers.get('set-cookie')!.includes('; Secure'), secureCookies !== false);
      assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
    }
  }
});

test('configuration preserves an independent copy of trusted proxy addresses', () => {
  const addresses = ['192.0.2.1'];
  const config = resolveConfig({ trustedProxies: addresses });
  addresses.push('192.0.2.2');
  assert.deepEqual(config.trustedProxies, ['192.0.2.1']);
});
