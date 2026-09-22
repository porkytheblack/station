import { createServer } from 'node:tls';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

// Transport-only TLS termination for this fixed local daemon. HTTP, SSE and
// WebSocket traffic use the existing authenticated Station server unchanged.
export async function startTLSProxy(stateDir) {
  const sockets = new Set();
  const server = createServer({ key: readFileSync(`${stateDir}/tls-key.pem`), cert: readFileSync(`${stateDir}/tls-cert.pem`), minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, client => {
    const upstream = connect(5800, '127.0.0.1');
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); }
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(5843, '0.0.0.0', resolve); });
  return () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); });
}
