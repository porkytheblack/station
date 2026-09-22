import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sandbox, command, stateDir } from './shared.mjs';
const composeFile = fileURLToPath(new URL('./compose.yaml', import.meta.url));
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const compose = args => docker(['compose', '-f', composeFile, ...args]);
const { id } = JSON.parse(readFileSync(`${stateDir}/sandbox.json`, 'utf8'));
const metadata = JSON.parse(readFileSync(`${stateDir}/workspaces/${id}/workspace.json`, 'utf8'));
const inspect = name => JSON.parse(docker(['inspect', name]))[0];
const controllerId = compose(['ps', '-q', 'station']).trim();
const dashboardId = compose(['ps', '-q', 'dashboard']).trim();
assert(controllerId && dashboardId);
const controller = inspect(controllerId), dashboard = inspect(dashboardId), workload = inspect(metadata.container);
assert(controller.Mounts.some(m => m.Destination === '/var/run/docker.sock'));
assert(dashboard.Mounts.length === 1 && dashboard.Mounts[0].Destination === '/etc/station/ca.pem' && !dashboard.Mounts[0].RW);
assert(!dashboard.HostConfig.NetworkMode.startsWith('container:'));
assert(workload.Mounts.every(m => m.Type === 'volume' && m.Destination === '/home/node'));
assert.equal(workload.HostConfig.Privileged, false);
assert.equal(workload.HostConfig.ReadonlyRootfs, true);
assert.equal(workload.Config.User, '1000:1000');
assert.equal((await fetch('http://127.0.0.1:5801/api/v1/stations')).status, 401);

async function healthy() {
  for (let i = 0; i < 60; i++) {
    try {
      const services = await sandbox({ method: 'services', id });
      const gateway = services.find(s => s.name === 'hermes-gateway');
      if (gateway?.status === 'running' && (gateway.stdout + gateway.stderr).includes('Connected to Telegram') && (await fetch('http://127.0.0.1:5801/api/v1/health')).ok) return gateway;
    } catch { /* controller may be restarting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error('Controller/dashboard/gateway recovery deadline exceeded');
}
await healthy();
const marker = `compose-${Date.now()}`;
await sandbox({ method: 'writeFile', id, path: 'compose-persistence.txt', options: { base64: Buffer.from(marker).toString('base64') } });
const checks = ['separate containers and mount boundaries', 'dashboard API rejects unauthenticated access'];

// A second controller must be fenced before it can touch existing ownership.
const duplicate = spawnSync('docker', ['compose', '-f', composeFile, 'run', '--rm', '--no-deps', 'station'], { encoding: 'utf8', timeout: 15000 });
assert.equal(duplicate.status, 1, 'exclusive controller lock must reject a second owner');
assert.equal(duplicate.stdout, '', 'a fenced controller must never start the daemon');
assert(!duplicate.stderr.includes('Error:'), 'exit 1 must come from lock rejection, not a crashed second daemon');
await healthy();
checks.push('second controller rejected by exclusive lock');

// Probe without mounting a socket; never point it at the active controller state.
const probe = `import {ContainerSandboxAdapter} from '/app/packages/station-sandbox/dist/container.js'; const a=new ContainerSandboxAdapter({rootDir:'/tmp/probe',image:'unused:probe',enablePty:false}); try {await a.ready();process.exit(2)} catch(e){if(!['unavailable','unsupported'].includes(e.code))throw e;console.log('ENGINE_UNAVAILABLE_FAIL_CLOSED')}`;
assert(docker(['run', '--rm', '--network', 'none', '--read-only', '--user', 'node', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,size=32m,mode=1777', '--entrypoint', 'node', 'station-hermes-controller:local', '--input-type=module', '-e', probe]).includes('ENGINE_UNAVAILABLE_FAIL_CLOSED'));
checks.push('missing Docker socket fails closed');

if (process.argv.includes('--restart')) {
  // Kill the controller child, not Docker itself. The engine restart policy must
  // recover the controller, stale PID metadata, dashboard connectivity and agent.
  const kill = `const fs=require('fs');for(const name of fs.readdirSync('/proc')){if(!/^\\d+$/.test(name))continue;try{const a=fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\\0');if(a[1]==='examples/20-hermes-sandbox/container-entry.mjs'){process.kill(Number(name),'SIGKILL');process.exit(0)}}catch{}}process.exit(2)`;
  docker(['exec', controllerId, 'node', '-e', kill]);
  await new Promise(resolve => setTimeout(resolve, 2000));
  await healthy();
  assert(inspect(controllerId).RestartCount > controller.RestartCount);
  checks.push('automatic recovery after controller SIGKILL');
}
const file = await sandbox({ method: 'readFile', id, path: 'compose-persistence.txt' });
assert.equal(Buffer.from(file.base64, 'base64').toString(), marker);
const run = await command(id, 'printf COMPOSE_SHELL_OK; node --version; hermes gateway status', 30000);
assert.equal(run.status, 'completed');
assert(run.stdout.includes('COMPOSE_SHELL_OK') && run.stdout.includes('Gateway is running'));
checks.push('persistent workspace and shell access after recovery');
await healthy();
const report = { checkedAt: new Date().toISOString(), checks, controller: controllerId, dashboard: dashboardId, sandbox: id };
writeFileSync(`${stateDir}/compose-verification.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
