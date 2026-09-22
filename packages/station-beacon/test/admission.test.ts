import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BeaconRunner } from '../src/beacon-runner.js';

test('beacon admission revocation fences messages, skips renewals and reaps a stubborn child', async t => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);console.log("ready")'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL')); await once(child.stdout!, 'data');
  const exited = once(child, 'exit'); let renewals = 0;
  const runner = new BeaconRunner({ canClaim: async () => true, canRenew: async () => false, networkCoordinator: {
    acquireControllerLease: async () => true, releaseControllerLease: async () => true,
    renewControllerLease: async () => { renewals++; return true; },
  } });
  const supervised = { child, leaseLost: false, exitHandled: false, stopRequested: false };
  (runner as any).supervised.set('instance', supervised);
  (runner as any).networkLeaseByInstance.set('instance', { name: 'lease', token: 'token' });
  assert.equal(await (runner as any).renewNetworkLeases(new Date()), false);
  assert.equal(supervised.leaseLost, true, 'late child messages are fenced');
  assert.equal(renewals, 0);
  assert.equal((await exited)[1], 'SIGKILL');
});

test('beacon admission errors fail closed while draining is separate', async () => {
  const denied = new BeaconRunner({ canRenew: async () => { throw new Error('offline'); } });
  assert.equal(await (denied as any).renewNetworkLeases(new Date()), false);
  const draining = new BeaconRunner({ canClaim: async () => false, canRenew: async () => true });
  assert.equal(await (draining as any).renewNetworkLeases(new Date()), true);
});
