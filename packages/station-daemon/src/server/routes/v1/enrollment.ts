import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { EnrollmentAuthority, EnrollmentError } from '../../../enrollment/authority.js';

function routes() {
  const app = new Hono();
  app.onError((error, c) => error instanceof EnrollmentError ? c.json({ error: error.code }, error.status) : c.json({ error: 'enrollment_unavailable' }, 503));
  return app;
}
const parseBody: MiddlewareHandler = async (c, next) => {
    // Limit even chunked input. JSON parse errors are explicit client errors.
    const reader = c.req.raw.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) { try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 4096) { await reader.cancel(); return c.json({ error: 'body_too_large' }, 413); } chunks.push(part.value); } } finally { reader.releaseLock(); } }
    let body: unknown = {};
    try { if (size) body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'invalid_body' }, 400);
    c.set('enrollmentBody' as never, body as never); await next();
};
function body(c: Context): Record<string, any> { return c.get('enrollmentBody'); }
function bearer(c: Context): string { const value = c.req.header('authorization'); if (!value?.startsWith('Bearer ')) throw new EnrollmentError('admission_denied', 401); return value.slice(7); }
/** Mount publicly with a rate limiter; these routes authenticate invitation/worker credentials themselves. */
export function v1EnrollmentWorkerRoutes(authority: EnrollmentAuthority) {
  const app = routes();
  app.post('/network/join', parseBody, async c => c.json({ data: await authority.join(body(c) as any) }, 201));
  app.post('/network/admission', parseBody, async c => { const b = body(c); return c.json({ data: await authority.admit(b.stationId, b.networkId, bearer(c)) }); });
  app.post('/network/leave', parseBody, async c => { const b = body(c); await authority.leave(b.stationId, b.networkId, bearer(c)); return c.body(null, 204); });
  return app;
}
/** Mount only under an authenticated admin guard. Never expose invitation issuance on an auth-disabled daemon. */
export function v1EnrollmentAdminRoutes(authority: EnrollmentAuthority) {
  const app = routes();
  app.post('/network/enrollments', parseBody, async c => { const b = body(c); return c.json({ data: await authority.issue(b.stationId, b.ttlMs) }, 201); });
  app.get('/network/members', async c => c.json({ data: await authority.list() }));
  app.delete('/network/members/:id', async c => { await authority.revoke(c.req.param('id')); return c.body(null, 204); });
  return app;
}
