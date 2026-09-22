import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
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

test('authority outages deny new claims but preserve existing work only inside bounded renewal grace; revocation clears grace',async t=>{
 let mode='ok',now=1000;
 const app=new Hono();app.post('/api/v1/network/admission',c=>mode==='ok'?c.json({data:{stationId:'worker',networkId:'fleet',generation:'generation',joinedAt:new Date(0).toISOString()}}):c.json({error:mode},mode==='denied'?401:503));
 const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const options={url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,networkId:'fleet',stationId:'worker',credential:`stw_${'a'.repeat(43)}`,renewalGraceMs:1000,now:()=>now};
 const admission=createEnrollmentAdmission(options);assert.equal(await admission.canClaim(),true);mode='unavailable';assert.equal((await admission.probe()).state,'unavailable');assert.equal(await admission.canClaim(),false);assert.equal(await admission.canRenew(),true);assert.equal(await createEnrollmentAdmission(options).canRenew(),false,'no grace without a successful admission');now+=1001;assert.equal(await admission.canRenew(),false);
 mode='ok';assert.equal(await admission.canClaim(),true);mode='denied';assert.equal((await admission.probe()).state,'denied');assert.equal(await admission.canRenew(),false);mode='unavailable';assert.equal(await admission.canRenew(),false,'outage cannot resurrect a revoked worker');
});


test('a crashed lock owner is recovered while live owner locks remain protected',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'station-enroll-lock-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'authority.json');
 const child=spawn(process.execPath,['-e',`const fs=require('node:fs');const birth=process.platform==='linux'?fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+fs.readFileSync('/proc/'+process.pid+'/stat','utf8').split(') ')[1].split(' ')[19]:require('node:child_process').execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{env:{...process.env,TZ:'UTC',LC_ALL:'C'}}).toString().trim();fs.mkdirSync(process.argv[1]);fs.writeFileSync(process.argv[1]+'/owner.json',JSON.stringify({version:2,pid:process.pid,birth,host:require('node:os').hostname(),token:require('node:crypto').randomUUID()}),{mode:0o600,flag:'wx'});process.stdout.write('ready');setInterval(()=>{},1000);`,`${path}.lock`],{stdio:['ignore','pipe','inherit']});t.after(()=>child.kill('SIGKILL'));await once(child.stdout!,'data');
 const authority=new EnrollmentAuthority({path,networkId:'fleet'});await assert.rejects(authority.issue('live-protected'),{code:'enrollment_busy'});const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
 const [a,b]=await Promise.all([authority.issue('worker-a'),new EnrollmentAuthority({path,networkId:'fleet'}).issue('worker-b')]);assert.equal((await authority.join(a)).stationId,'worker-a');assert.equal((await authority.join(b)).stationId,'worker-b');
});

test('BeaconRunner retains its real child during authority 503 and default request timeout, then fences revocation', {timeout:15000}, async t=>{
 const {BeaconRunner}=await import('station-beacon');let mode='ok',renewals=0;
 const app=new Hono();app.post('/api/v1/network/admission',async c=>{if(mode==='timeout')await new Promise(resolve=>setTimeout(resolve,2500));return mode==='ok'?c.json({data:{stationId:'worker',networkId:'fleet',generation:'one'}}):c.json({error:mode},mode==='denied'?401:503);});
 const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const admission=createEnrollmentAdmission({url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,stationId:'worker',networkId:'fleet',credential:`stw_${'b'.repeat(43)}`});assert.equal(await admission.canClaim(),true);
 const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000);console.log("ready")'],{stdio:['ignore','pipe','ignore']});t.after(()=>child.kill('SIGKILL'));await once(child.stdout!,'data');const exit=once(child,'exit');
 const runner=new BeaconRunner({canClaim:admission.canClaim,canRenew:admission.canRenew,networkCoordinator:{acquireControllerLease:async()=>true,releaseControllerLease:async()=>true,renewControllerLease:async()=>{renewals++;return true;}}});
 const supervised={child,leaseLost:false,exitHandled:false,stopRequested:false};(runner as any).supervised.set('instance',supervised);(runner as any).networkLeaseByInstance.set('instance',{name:'lease',token:'token'});
 mode='unavailable';assert.equal(await admission.canClaim(),false);assert.equal(await (runner as any).renewNetworkLeases(new Date()),true);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
 mode='timeout';const started=Date.now();assert.equal(await (runner as any).renewNetworkLeases(new Date()),true);assert.ok(Date.now()-started<4500,'request timeout resolves before supervisor admission deadline');assert.equal(supervised.leaseLost,false);assert.equal(child.signalCode,null);assert.equal(renewals,2);
 mode='denied';assert.equal(await (runner as any).renewNetworkLeases(new Date()),false);assert.equal(supervised.leaseLost,true);assert.equal((await exit)[1],'SIGKILL');assert.equal(renewals,2);
 assert.throws(()=>createEnrollmentAdmission({url:'https://authority.example',stationId:'w',networkId:'f',credential:`stw_${'b'.repeat(43)}`,timeoutMs:5000}),/Invalid/);
});


test('lock recovery detects recycled PID birth while unrecognized empty legacy locks fail within a deadline',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'station-enroll-reuse-'));t.after(()=>rm(directory,{recursive:true,force:true}));const path=join(directory,'authority.json'),lock=`${path}.lock`;
 await mkdir(lock);await writeFile(join(lock,'owner.json'),JSON.stringify({version:2,pid:process.pid,birth:'prior-boot-or-reused-pid',host:(await import('node:os')).hostname(),token:'00000000-0000-4000-8000-000000000000'}));const authority=new EnrollmentAuthority({path,networkId:'fleet'});assert.equal((await authority.issue('worker')).stationId,'worker');
 await mkdir(lock);const start=Date.now();await assert.rejects(authority.issue('legacy'),error=>error instanceof Error&&error.message.includes(lock));assert.ok(Date.now()-start<3000);
});
