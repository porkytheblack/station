import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
async function port() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
test('dashboard ignores ambient HOSTNAME and serves on its loopback default', { timeout: 30_000 }, async t => {
  const listenPort = await port();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/station-dashboard.mjs', import.meta.url))], {
    env: { ...process.env, HOSTNAME: 'not-a-valid-station-interface.invalid', STATION_DASHBOARD_HOST: '', PORT: String(listenPort), STATION_DAEMON_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000); await exited; clearTimeout(timer);
  });
  for (let attempt = 0; !output.includes('[station-dashboard]'); attempt++) {
    if (child.exitCode !== null || child.signalCode !== null || attempt > 150) throw new Error(`Dashboard startup failed: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(output, new RegExp(`\\[station-dashboard\\] http://127\\.0\\.0\\.1:${listenPort}`));
  const response = await fetch(`http://127.0.0.1:${listenPort}/`, { redirect: 'manual' }); await response.body?.cancel();
  assert.ok(response.status >= 200 && response.status < 400);
});
