// Offline backup: contains credentials. Keep private; encrypt before moving off-host.
import { readFileSync, mkdirSync, openSync, closeSync, cpSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopLocal, localStatus } from '../../packages/station-cli/dist/lifecycle.js';
import { stateDir } from './shared.mjs';
const { id } = JSON.parse(readFileSync(`${stateDir}/sandbox.json`, 'utf8'));
const meta = JSON.parse(readFileSync(`${stateDir}/workspaces/${id}/workspace.json`, 'utf8'));
const destination = `${stateDir}/backups/${new Date().toISOString().replaceAll(':', '-')}`;
const compose = existsSync(`${stateDir}/runtime.json`) && JSON.parse(readFileSync(`${stateDir}/runtime.json`, 'utf8')).mode === 'compose';
const composeFile = fileURLToPath(new URL('./compose.yaml', import.meta.url));
if (compose) {
  if (spawnSync('docker', ['compose', '-f', composeFile, 'stop'], { stdio: 'inherit' }).status !== 0) throw Error('Could not stop Compose for a consistent backup');
} else {
  const status = await localStatus('daemon', 'hermes', `${stateDir}/cli`);
  if (status.status !== 'running') throw Error('Start the managed daemon before taking a backup.');
  await stopLocal('daemon', 'hermes', `${stateDir}/cli`);
}
try {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const fd = openSync(`${destination}/home.tar.gz`, 'wx', 0o600);
  try {
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', '1000:1000',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--security-opt', `seccomp=${stateDir}/seccomp.json`, '--memory', '256m', '--pids-limit', '32',
      '--mount', `type=volume,source=${meta.volume},target=/source,readonly`,
      '--entrypoint', '/bin/tar', meta.image, '-C', '/source', '-czf', '-', '.'],
      { stdio: ['ignore', fd, 'pipe'], timeout: 120000 });
    if (result.status !== 0) throw Error('Volume backup failed; incomplete archive retained for inspection.');
  } finally { closeSync(fd); }
  for (const name of ['settings.json', 'sandbox.json', 'api-key', 'seccomp.json', 'daemon', 'workspaces', ...(compose ? ['runtime.json', 'tls-key.pem', 'tls-cert.pem'] : [])]) {
    cpSync(`${stateDir}/${name}`, `${destination}/${name}`, { recursive: true, errorOnExist: true });
  }
  console.log(`Private offline backup: ${destination}`);
} finally {
  const started = compose
    ? spawnSync('docker', ['compose', '-f', composeFile, 'up', '-d', '--wait'], { stdio: 'inherit' })
    : spawnSync(process.execPath, [fileURLToPath(new URL('./manage.mjs', import.meta.url)), 'start'], { stdio: 'inherit' });
  if (started.status !== 0) throw Error('Restart failed after backup; inspect managed service logs.');
}
