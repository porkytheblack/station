// Operator-only maintenance: preserve volumes, running/recent containers and their images.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { stateDir } from './shared.mjs';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const cutoff = new Date(); cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
const ids = docker(['ps', '-aq']).trim().split(/\s+/).filter(Boolean);
const old = ids.length ? JSON.parse(docker(['inspect', ...ids])).filter(c =>
  !c.State.Running && c.State.Status === 'exited' &&
  new Date(c.Created) < cutoff && new Date(c.State.FinishedAt) < cutoff &&
  !c.Name.startsWith('/station-') && !c.Config.Labels?.['station.sandbox.owner']
).map(c => ({ id: c.Id, name: c.Name, created: c.Created, lastStopped: c.State.FinishedAt })) : [];
console.log(JSON.stringify({ cutoff: cutoff.toISOString(), stoppedContainers: old, volumes: 'preserved' }, null, 2));
if (process.argv.includes('--apply')) {
  const before = docker(['system', 'df']);
  // No force and no -v: engine refuses running containers and keeps their volumes.
  const containers = old.length ? docker(['rm', ...old.map(c => c.id)]) : 'None';
  const images = docker(['image', 'prune', '-a', '-f', '--filter', `until=${cutoff.toISOString()}`]);
  const networks = docker(['network', 'prune', '-f', '--filter', `until=${cutoff.toISOString()}`]);
  const hours = Math.floor((Date.now() - cutoff.getTime()) / 3600000);
  const cache = docker(['builder', 'prune', '-a', '-f', '--filter', `until=${hours}h`]);
  const after = docker(['system', 'df']);
  writeFileSync(`${stateDir}/docker-cleanup.json`, JSON.stringify({ cutoff, old, before, containers, images, networks, cache, after }, null, 2), { mode: 0o600 });
  console.log(images, networks, cache, after);
}
