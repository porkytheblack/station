import { Hono } from 'hono';
import { requireScope } from '../server/middleware/scope-guard.js';
import { registrySource, type RegistryUpstream } from './source.js';
export type RegistryTargets = Record<string, Pick<RegistryUpstream, 'url' | 'token'>>;
const limit = 256 * 1024 * 1024;
async function bounded(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum) throw new Error('Transfer exceeds proxy limit'); chunks.push(part.value); }
    return new Uint8Array(Buffer.concat(chunks));
  } finally { await reader.cancel(); reader.releaseLock(); }
}
/** Explicit operator-owned destinations; clients cannot provide a URL or worker credential. */
export function registryProxyRoutes(targets: RegistryTargets) {
  const entries = new Map(Object.entries(targets).map(([id, config]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(id)) throw new Error('Invalid registry target Station ID');
    registrySource(config); // same HTTPS, origin and credential validation as registry pulls
    return [id, { ...config }];
  }));
  const app = new Hono();
  app.use('/stations/:stationId/registry/*', requireScope('admin'));
  app.all('/stations/:stationId/registry/*', async c => {
    const id = c.req.param('stationId'), target = entries.get(id);
    if (!target) return c.json({ error: 'registry_target_not_configured' }, 404);
    const suffix = c.req.path.match(/\/stations\/[^/]+\/registry\/(.*)$/)?.[1] ?? '';
    if (!/^[a-zA-Z0-9._~%:/-]+$/.test(suffix) || suffix.includes('..') || /%2f|%5c|%2e/i.test(suffix)) return c.json({ error: 'invalid_registry_path' }, 400);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) return c.json({ error: 'method_not_allowed' }, 405);
    try {
      // Check actual identity before forwarding every mutation/read. A misconfigured
      // endpoint must never publish to a different Station merely because it is live.
      const info = await fetch(new URL('/api/v1/info', target.url), { headers: { authorization: `Bearer ${target.token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
      const handshake = JSON.parse(Buffer.from(await bounded(info.body, 64 * 1024)).toString('utf8'));
      if (!info.ok || handshake?.data?.stationId !== id || handshake?.data?.protocol !== 'station.api/v1' || !/^3\./.test(handshake?.data?.version ?? '')) return c.json({ error: 'registry_target_mismatch' }, 502);
      const headers = new Headers({ authorization: `Bearer ${target.token}`, 'X-Station-Image-Worker': id });
      for (const name of ['content-type', 'upload-offset', 'x-chunk-sha256']) { const value = c.req.header(name); if (value) headers.set(name, value); }
      const body = ['GET', 'HEAD'].includes(c.req.method) ? undefined : await bounded(c.req.raw.body, limit);
      const response = await fetch(new URL(`/api/v1/registry/${suffix}${new URL(c.req.url).search}`, target.url), { method: c.req.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(60000) });
      const result = await bounded(response.body, limit);
      const output = new Headers({ 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      for (const name of ['content-type', 'upload-offset', 'upload-max-chunk-bytes', 'retry-after']) { const value = response.headers.get(name); if (value) output.set(name, value); }
      return new Response(response.status === 204 ? null : result, { status: response.status, headers: output });
    } catch { return c.json({ error: 'registry_target_unavailable', message: 'Private registry request failed; inspect upload status before retrying a transfer.' }, 502); }
  });
  return app;
}
