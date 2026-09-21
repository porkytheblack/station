import http from 'node:http';
import https from 'node:https';

export function targetURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Daemon URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Remote Station endpoints require HTTPS.');
  }
  return url;
}

// The destination is operator-configured once, never taken from a request.
export function dashboardProxy(daemon, frontend) {
  daemon = targetURL(daemon);
  frontend = targetURL(frontend);
  const sockets = new Set();
  const sameOrigin = (req) => {
    if (!req.headers.origin) return true; // command-line and same-origin non-browser clients
    try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
  };
  const headers = (req, target) => {
    const copy = { ...req.headers, host: target.host };
    for (const key of ['connection', 'proxy-authorization', 'proxy-authenticate', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for']) delete copy[key];
    return copy;
  };
  const server = http.createServer((req, res) => {
    const api = req.url?.startsWith('/api/');
    if (api && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
      res.writeHead(403); res.end('Cross-origin request rejected'); return;
    }
    const target = api ? daemon : frontend;
    const transport = target.protocol === 'https:' ? https : http;
    const upstream = transport.request(target, { method: req.method, path: req.url, headers: headers(req, target) }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Upstream unavailable'); });
    // Streaming downloads and SSE can remain open; disconnect must cancel upstream.
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/events' || !sameOrigin(req)) { socket.destroy(); return; }
    const transport = daemon.protocol === 'https:' ? https : http;
    const upstream = transport.request(daemon, { path: '/api/events', headers: { ...headers(req, daemon), connection: 'Upgrade', upgrade: 'websocket' } });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote); remote.on('close', () => sockets.delete(remote));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on('close', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
    });
    upstream.on('response', (response) => { socket.end(`HTTP/1.1 ${response.statusCode} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); response.resume(); });
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.end();
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); } };
}
