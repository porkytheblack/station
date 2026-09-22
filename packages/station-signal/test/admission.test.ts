import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SignalRunner } from '../src/signal-runner.js';
import { MemoryAdapter } from '../src/adapters/memory.js';

test('denied or unavailable renewal admission fences a stubborn child before renewing leases', async t => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);console.log("ready")'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout!, 'data');
  const exited = once(child, 'exit');
  const adapter = new MemoryAdapter(); let touched = 0;
  adapter.requeueExpiredRuns = async () => { touched++; return 0; };
  adapter.renewRunLease = async () => { touched++; return true; };
  const runner = new SignalRunner({ adapter, canClaim: async () => true, canRenew: async () => { throw new Error('authority offline'); }, killGraceMs: 20 });
  (runner as any).childByRunId.set('running', child);
  assert.equal(await (runner as any).recoverAndRenewLeases(), false);
  assert.equal(touched, 0, 'admission failure cannot renew or mutate queue recovery');
  assert.equal((await exited)[1], 'SIGKILL', 'denial cleanup escalates even when SIGTERM is ignored');
});

test('draining new claims does not revoke active renewal admission', async () => {
  const runner = new SignalRunner({ canClaim: async () => false, canRenew: async () => true });
  assert.equal(await (runner as any).recoverAndRenewLeases(), true);
});
