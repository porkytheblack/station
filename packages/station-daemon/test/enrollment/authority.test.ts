import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { EnrollmentAuthority } from '../../src/enrollment/authority.js';
import { createEnrollmentAdmission } from '../../src/enrollment/client.js';
import { v1EnrollmentAdminRoutes, v1EnrollmentWorkerRoutes } from '../../src/server/routes/v1/enrollment.js';

test('durable one-use identity-bound enrollment, rotation, revocation and expiry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'station-enroll-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'authority.json'); let now = 100000;
  const authority = new EnrollmentAuthority({ path, networkId: 'fleet', now: () => now });
  const invite = await authority.issue('worker-a', 1000);
  await assert.rejects(authority.join({ ...invite, networkId: 'other' }), /invalid_enrollment/);
  await assert.rejects(authority.join({ ...invite, stationId: 'worker-b' }), /invalid_enrollment/);
  const worker = await authority.join(invite);
  assert.equal((await authority.admit('worker-a', 'fleet', worker.credential)).generation, worker.generation);
  const restarted = new EnrollmentAuthority({ path, networkId: 'fleet', now: () => now });
  await assert.rejects(restarted.join(invite), /invalid_enrollment/);
  assert.equal((await restarted.admit('worker-a', 'fleet', worker.credential)).stationId, 'worker-a');
  const pending = await restarted.issue('worker-a');
  await restarted.revoke('worker-a');
  await assert.rejects(authority.admit('worker-a', 'fleet', worker.credential), /admission_denied/);
  await assert.rejects(authority.join(pending), /invalid_enrollment/);
  const replacement = await authority.join(await authority.issue('worker-a'));
  assert.notEqual(replacement.generation, worker.generation);
  await assert.rejects(authority.admit('worker-a', 'fleet', worker.credential), /admission_denied/);
  await authority.leave('worker-a', 'fleet', replacement.credential);
  await assert.rejects(authority.admit('worker-a', 'fleet', replacement.credential), /admission_denied/);
  const expired = await authority.issue('worker-b', 1000); now += 1000;
  await assert.rejects(authority.join(expired), /invalid_enrollment/);
  const persisted = await readFile(path, 'utf8');
  for (const secret of [invite.token, worker.credential, pending.token, replacement.credential]) assert.equal(persisted.includes(secret), false);
  assert.equal(JSON.stringify(await authority.list()).includes('credentialHash'), false);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(new EnrollmentAuthority({ path, networkId: 'other' }).list(), /enrollment_store_invalid/);
});

test('independent authorities cannot concurrently redeem the same invitation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'station-enroll-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { path: join(directory, 'authority.json'), networkId: 'fleet' };
  const a = new EnrollmentAuthority(options), b = new EnrollmentAuthority(options);
  const invite = await a.issue('worker');
  const results = await Promise.allSettled([a.join(invite), b.join(invite)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(b.join(invite), /invalid_enrollment/);
});

test('real HTTP admission rejects revoked credentials, bad network, oversized inputs and unavailable authority', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'station-enroll-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = new EnrollmentAuthority({ path: join(directory, 'authority.json'), networkId: 'fleet' });
  const app = new Hono();
  app.route('/api/v1', v1EnrollmentWorkerRoutes(authority));
  const admin = v1EnrollmentAdminRoutes(authority);
  // Test harness models the daemon's admin guard; worker credential cannot mint invitations.
  app.use('/api/v1/network/enrollments', async (c, next) => c.req.header('authorization') === 'Bearer operator' ? next() : c.json({ error: 'unauthorized' }, 401));
  app.use('/api/v1/network/members/*', async (c, next) => c.req.header('authorization') === 'Bearer operator' ? next() : c.json({ error: 'unauthorized' }, 401));
  app.route('/api/v1', admin);
  app.post('/unrelated', async c => c.json(await c.req.json()));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, body: unknown, token?: string) => fetch(`${url}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request('/network/enrollments', { stationId: 'worker' })).status, 401);
  const invite = await (await request('/network/enrollments', { stationId: 'worker' }, 'operator')).json() as any;
  const joined = await (await request('/network/join', invite.data)).json() as any;
  assert.equal((await request('/network/join', invite.data)).status, 401);
  const admission = createEnrollmentAdmission({ url, networkId: 'fleet', stationId: 'worker', credential: joined.data.credential });
  assert.equal(await admission.canClaim(), true);
  assert.equal(await createEnrollmentAdmission({ url, networkId: 'wrong', stationId: 'worker', credential: joined.data.credential }).canClaim(), false);
  assert.equal((await request('/network/enrollments', { stationId: 'worker' }, joined.data.credential)).status, 401);
  assert.equal((await request('/network/join', { token: 'x'.repeat(5000) })).status, 413);
  assert.equal((await fetch(`${url}/unrelated`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"untouched":true}' }).then(r => r.json()) as any).untouched, true);
  await authority.revoke('worker');
  assert.equal(await admission.canClaim(), false);
  assert.equal((await request('/network/admission', { networkId: 'fleet', stationId: 'worker' }, joined.data.credential)).status, 401);
  await new Promise<void>(r => server.close(() => r()));
  assert.equal(await admission.canClaim(), false);
});

test('frequent concurrent admission reads do not block durable revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'station-enroll-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = new EnrollmentAuthority({ path: join(directory, 'authority.json'), networkId: 'fleet' });
  const member = await authority.join(await authority.issue('worker'));
  const reads = Array.from({ length: 40 }, () => authority.admit('worker', 'fleet', member.credential).catch(() => null));
  await authority.revoke('worker');
  await Promise.all(reads);
  await assert.rejects(authority.admit('worker', 'fleet', member.credential), /admission_denied/);
});
