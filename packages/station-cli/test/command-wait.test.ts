import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HostSandboxAdapter } from '../../station-sandbox/src/index.js';
import { ContextStore } from '../src/store.js';
import { commandExitCode, waitSandboxCommand } from '../src/command-wait.js';
import { serializeCliError } from '../src/errors.js';
import { StationApiError, StationClient } from 'station-client';
import { parseArgs } from '../src/commands.js';

test('real CLI waits for HostSandbox commands, preserves remote output/exit, and detaches on timeout or SIGINT', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'station-cli-wait-'));
  const adapter = new HostSandboxAdapter({ rootDir: join(directory, 'sandboxes'), maxTimeoutMs: 10000 });
  const sandbox = await adapter.create(); let cancellations = 0, polls = 0, dispatches = 0; let onPoll: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    try {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/info') { res.end(JSON.stringify({ data: { protocol: 'station.api/v1', version: '3.0.0', stationId: 'worker', role: 'station', capabilities: ['execution'] } })); return; }
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); let result;
      if (body.method === 'exec') { dispatches++; result = await adapter.exec(body.id, { command: body.command, timeoutMs: body.timeoutMs }); }
      else if (body.method === 'command') { polls++; onPoll?.(); result = await adapter.command(body.id, body.runId); }
      else if (body.method === 'cancel') { cancellations++; result = await adapter.cancel(body.id, body.runId); }
      else throw new Error('unexpected command');
      res.end(JSON.stringify({ data: result }));
    } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_input' })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const home = join(directory, 'cli'); await new ContextStore(home).add('test', { url });
  t.after(async () => { await adapter.close(); await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); });
  const run = (flags: string[], interrupt = false) => {
    const child = spawn(process.execPath, [resolve('dist/cli.js'), ...flags], { env: { ...process.env, STATION_CLI_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    if (interrupt) onPoll = () => { onPoll = undefined; child.kill('SIGINT'); };
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
  };
  const base = ['sandbox', 'exec', sandbox.id, '--station', 'worker'];
  const done = await run([...base, '--command', 'printf "hello\\n"; printf "warning\\n" >&2; exit 7', '--wait', '--json-errors']);
  assert.equal(done.code, 7); assert.equal(done.stderr, '');
  const result = JSON.parse(done.stdout); assert.equal(result.stdout, 'hello\n'); assert.equal(result.stderr, 'warning\n'); assert.equal(result.exitCode, 7); assert.ok(polls > 0);
  const asyncResult = await run([...base, '--command', 'sleep 1; exit 9']); assert.equal(asyncResult.code, 0); assert.equal(JSON.parse(asyncResult.stdout).status, 'running');
  const timeout = await run([...base, '--command', 'sleep 5', '--wait', '--wait-timeout-ms', '20', '--json-errors']);
  assert.equal(timeout.code, 124); assert.equal(JSON.parse(timeout.stderr).error.code, 'wait_timeout');
  const detached = JSON.parse(timeout.stdout); assert.equal((await adapter.command(sandbox.id, detached.id)).status, 'running'); await adapter.cancel(sandbox.id, detached.id);
  const interrupt = await run([...base, '--command', 'sleep 5', '--wait', '--json-errors'], true);
  assert.equal(interrupt.code, 130); assert.equal(JSON.parse(interrupt.stderr).error.code, 'wait_interrupted');
  const interrupted = JSON.parse(interrupt.stdout); assert.equal((await adapter.command(sandbox.id, interrupted.id)).status, 'running'); await adapter.cancel(sandbox.id, interrupted.id);
  assert.equal(cancellations, 0, 'client interruption never sends remote cancellation'); assert.equal(dispatches, 4, 'each exec is dispatched exactly once');
  const bad = await run(['--json-errors', '--bad-option']); assert.equal(bad.code, 1); assert.equal(bad.stdout, ''); assert.equal(JSON.parse(bad.stderr).error.code, 'cli_error');
});

test('polling authorization errors preserve last result and do not issue a mutation retry', async () => {
  const initial = { id: 'command', sandboxId: 'space', status: 'running', stdout: 'kept', stderr: 'also kept', truncated: false, exitCode: null, startedAt: new Date().toISOString() };
  const calls: unknown[] = [];
  const client = new StationClient({ url: 'https://worker.example' }, { fetch: async (_url, request) => { calls.push(JSON.parse(String(request?.body))); return new Response(JSON.stringify({ error: 'forbidden', message: 'provider-secret-token' }), { status: 403 }); } });
  await assert.rejects(waitSandboxCommand(client, 'owner', 'space', initial, { pollIntervalMs: 1 }), error => {
    const failure = error as any; assert.equal(failure.code, 'wait_transport_error'); assert.equal(failure.status, 403); assert.deepEqual(failure.lastResult, initial); return true;
  });
  assert.deepEqual(calls, [{ method: 'command', id: 'space', runId: 'command' }]);
  assert.deepEqual(serializeCliError(new StationApiError('forbidden', 403, 'provider-secret-token')), { error: { code: 'forbidden', status: 403, message: 'Station API request failed. No automatic retry was made.' } });
  assert.equal(JSON.stringify(serializeCliError(new Error('secret'))).includes('secret'), false);
  assert.equal(commandExitCode({ ...initial, status: 'timed_out' } as any), 124);
  assert.equal(commandExitCode({ ...initial, status: 'cancelled' } as any), 130);
  assert.equal(commandExitCode({ ...initial, status: 'interrupted' } as any), 125);
  assert.deepEqual(parseArgs(['--json-errors', 'sandbox', 'exec', 'id', '--wait']).flags, Object.assign(Object.create(null), { 'json-errors': true, wait: true }));
});
