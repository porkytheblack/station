// A separate flock parent must own /data/controller.lock for our lifetime.
// Node/dependencies may close inherited descriptors: do not use --no-fork.
// A stable hostname + the shared kernel lock fences Compose replicas before
// clearing stale process IDs left by a killed/recreated PID namespace.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { stateDir } from './shared.mjs';
if (process.env.STATION_COMPOSE_OWNER !== '1' || hostname() !== 'station-hermes-controller') {
  throw Error('This entrypoint requires the Compose controller and its exclusive flock.');
}
const path = `${stateDir}/workspaces/.station-owner.json`;
if (existsSync(path)) {
  const previous = JSON.parse(readFileSync(path, 'utf8'));
  if (previous.hostname !== hostname()) throw Error('Another host owns this workspace. Stop the old controller before migrating.');
  rmSync(path);
}
await import('./daemon.mjs');
writeFileSync(`${stateDir}/runtime.json`, JSON.stringify({ mode: 'compose' }), { mode: 0o600 });
