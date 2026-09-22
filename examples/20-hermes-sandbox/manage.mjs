import { startLocal, stopLocal, localStatus } from '../../packages/station-cli/dist/lifecycle.js';
import { root, stateDir } from './shared.mjs';
import { existsSync, readFileSync } from 'node:fs';
const action = process.argv[2] ?? 'status';
if (action === 'start' && existsSync(`${stateDir}/runtime.json`) && JSON.parse(readFileSync(`${stateDir}/runtime.json`, 'utf8')).mode === 'compose') {
  throw Error('This deployment uses Compose. Run docker compose -f examples/20-hermes-sandbox/compose.yaml up -d --wait instead.');
}
const home = `${stateDir}/cli`;
for (const kind of action === 'stop' ? ['dashboard', 'daemon'] : ['daemon', 'dashboard']) {
  const common = { kind, instance: 'hermes', home };
  if (action === 'start') {
    console.log(await startLocal({ ...common, cwd: root,
      entrypoint: kind === 'daemon' ? `${root}examples/20-hermes-sandbox/daemon.mjs` : `${root}packages/station-dashboard/bin/station-dashboard.mjs`, args: [],
      endpoint: `http://127.0.0.1:${kind === 'daemon' ? 5800 : 5801}`,
      env: kind === 'dashboard' ? { PORT: '5801', STATION_DASHBOARD_HOST: '127.0.0.1', STATION_DAEMON_URL: 'http://127.0.0.1:5800' } : {},
    }));
  } else if (action === 'stop') console.log(await stopLocal(kind, 'hermes', home));
  else if (action === 'status') console.log(await localStatus(kind, 'hermes', home));
  else throw new Error('Usage: node examples/20-hermes-sandbox/manage.mjs start|stop|status');
}
