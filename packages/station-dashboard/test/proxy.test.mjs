import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { dashboardProxy, targetURL } from '../bin/proxy.mjs';

async function listen(server) { await new Promise((r) => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${server.address().port}`; }
test('standalone proxy preserves authenticated API, streams and WebSocket while UI and daemon stay separate', async (t) => {
  const daemon = http.createServer((req, res) => {
    if (req.url === '/api/auth/login') { res.setHeader('set-cookie', 'station_session=test; HttpOnly; Path=/'); res.end('ok'); return; }
    if (req.headers.cookie !== 'station_session=test') { res.writeHead(401); res.end(); return; }
    res.setHeader('content-type', 'text/event-stream'); res.write('data: hello\n\n'); res.end('data: world\n\n');
  });
  const wss = new WebSocketServer({ noServer: true });
  daemon.on('upgrade', (req, socket, head) => {
    if (req.headers.cookie !== 'station_session=test') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.send('event'); });
  });
  const frontend = http.createServer((_, res) => res.end('dashboard'));
  const daemonURL = await listen(daemon); const uiURL = await listen(frontend);
  const proxy = dashboardProxy(daemonURL, uiURL); const base = await listen(proxy.server);
  t.after(async () => { await proxy.close(); wss.close(); await Promise.all([new Promise((r) => daemon.close(r)), new Promise((r) => frontend.close(r))]); });
  assert.equal(await (await fetch(base)).text(), 'dashboard');
  assert.deepEqual(await (await fetch(`${base}/api/dashboard/context`)).json(), { data: { daemonURL } });
  assert.equal((await fetch(`${base}/api/data`)).status, 401);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST' });
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  const response = await fetch(`${base}/api/data`, { headers: { cookie: 'station_session=test' } });
  assert.equal(await response.text(), 'data: hello\n\ndata: world\n\n');
  assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: 'https://attacker.invalid' } })).status, 403);
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/api/events`, { headers: { cookie: 'station_session=test' } });
  const event = await new Promise((resolve, reject) => { ws.once('message', (data) => resolve(data.toString())); ws.once('error', reject); });
  assert.equal(event, 'event'); ws.close();
  await proxy.close();
  assert.equal((await fetch(`${daemonURL}/api/auth/login`, { method: 'POST' })).status, 200, 'closing dashboard must not stop daemon');
});
test('fixed upstream rejects credentials and path injection', () => {
  for (const value of ['file:///tmp/x', 'https://secret:password@example.com', 'http://localhost/path', 'http://localhost/?url=http://evil']) assert.throws(() => targetURL(value));
});
test('remote upstreams require TLS before the proxy can forward credentials', () => {
  for (const value of [
    'http://hq.example.com', 'http://10.0.0.4:4400', 'http://192.168.1.2',
    'http://172.16.0.1', 'http://[fd00::1]', 'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
  ]) {
    assert.throws(() => targetURL(value), /require HTTPS/);
    assert.throws(() => dashboardProxy(value, 'http://127.0.0.1:4401'), /require HTTPS/);
  }
  assert.equal(targetURL('https://hq.example.com:8443').origin, 'https://hq.example.com:8443');
  for (const value of ['http://localhost:4400', 'http://127.0.0.1:4400', 'http://[::1]:4400']) {
    assert.equal(targetURL(value).origin, value);
  }
});
