import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

// Positive global-unicast policy. IPv6 is deliberately disabled in this deployment profile.
export function publicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}
function hostnameAllowed(hostname, allowed) {
  return allowed.some(entry => entry === '*' || entry === hostname || (entry.startsWith('*.') && hostname.endsWith(entry.slice(1)) && hostname !== entry.slice(2)));
}
export function createEgressProxy({ allowedHosts, maxConnections = 64, connectTimeoutMs = 5000, idleTimeoutMs = 30_000, maxTunnelBytes = 64 * 1024 * 1024, resolver = lookup, dial = net.connect } = {}) {
  if (!Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.some(host => typeof host !== 'string' || !/^(\*|(?:\*\.)?[a-z0-9][a-z0-9.-]*)$/.test(host))) throw new Error('Configure explicit allowedHosts (or explicit * for public IPv4 destinations).');
  for (const value of [maxConnections, connectTimeoutMs, idleTimeoutMs, maxTunnelBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid proxy limit');
  let active = 0;
  let pendingDns = 0;
  async function resolve(hostname) {
    if (pendingDns >= maxConnections) throw new Error('DNS capacity exhausted');
    pendingDns++;
    // A disconnected client cannot release the reservation for an unfinished OS lookup.
    const operation = Promise.resolve().then(() => resolver(hostname, { all: true, verbatim: true, family: 4 })).finally(() => { pendingDns--; });
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), connectTimeoutMs); timer.unref(); })]);
    } finally { clearTimeout(timer); }
  }
  const sockets = new Set();
  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 });
  server.maxConnections = maxConnections * 2;
  // CONNECT-only avoids request smuggling and forwarding hop-by-hop headers. Chromium supports HTTPS through CONNECT.
  server.on('request', (_req, res) => { res.writeHead(405, { connection: 'close' }); res.end('HTTPS CONNECT required'); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(idleTimeoutMs, () => socket.destroy()); });
  server.on('connect', async (req, client, head) => {
    let upstream;
    let released = false;
    const release = () => { if (!released) { released = true; active--; } };
    if (active >= maxConnections) { client.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
    active++;
    client.once('close', () => { release(); upstream?.destroy(); });
    const deny = () => { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); release(); };
    try {
      if (!req.url || !/^[a-zA-Z0-9.-]+:443$/.test(req.url) || head.length) return deny();
      const hostname = req.url.slice(0, -4).toLowerCase().replace(/\.$/, '');
      if (!hostnameAllowed(hostname, allowedHosts)) return deny();
      const answers = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await resolve(hostname);
      // Reject mixed public/private answers as well as IPv6, preventing fallback into restricted networks.
      if (!answers.length || answers.some(answer => !publicIPv4(answer.address))) return deny();
      if (client.destroyed) return release();
      // Pin the exact validated IP. Never let connect perform another DNS resolution.
      upstream = dial({ host: answers[0].address, port: 443, family: 4 });
      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
      upstream.once('error', () => { client.destroy(); release(); });
      upstream.once('close', () => { client.destroy(); release(); });
      upstream.once('connect', () => {
        if (client.destroyed) return upstream.destroy();
        upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        let bytes = 0;
        const count = chunk => { bytes += chunk.length; if (bytes > maxTunnelBytes) { client.destroy(); upstream.destroy(); } };
        client.on('data', count); upstream.on('data', count);
        client.pipe(upstream); upstream.pipe(client);
      });
    } catch { deny(); }
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(process.env.STATION_EGRESS_CONFIG ?? '{}');
  const proxy = createEgressProxy(config);
  proxy.server.listen(8080, '0.0.0.0');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void proxy.close().then(() => process.exit()); });
}
