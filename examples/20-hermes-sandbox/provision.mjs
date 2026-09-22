// Credentials travel over Docker stdin; never argv, build layers, or Station command history.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, stateDir } from './shared.mjs';
const credentials = process.argv.slice(2);
if (credentials.length < 2) throw Error('Usage: provision.mjs OPENROUTER_KEY_FILE TELEGRAM_TOKEN_FILE [TELEGRAM_USER_ID]');
const key = readFileSync(credentials[0], 'utf8').match(/sk-or-[A-Za-z0-9_-]+/)?.[0];
const token = readFileSync(credentials[1], 'utf8').match(/\b\d{5,}:[A-Za-z0-9_-]{20,}/)?.[0];
if (!key || !token) throw Error('Credential file format not recognized');
const user = credentials[2];
if (user && !/^\d+$/.test(user)) throw Error('Telegram user ID must be numeric');
const path = `${stateDir}/sandbox.json`;
const workspace = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : await sandbox({ method: 'create' });
writeFileSync(path, JSON.stringify(workspace), { mode: 0o600 });
const metadata = JSON.parse(readFileSync(`${stateDir}/workspaces/${workspace.id}/workspace.json`, 'utf8'));
const config = {
  model: { default: 'openai/gpt-4.1-mini', provider: 'openrouter' },
  agent: { max_turns: 20, gateway_timeout: 300 },
  terminal: { backend: 'local', cwd: '/home/node/workspace', home_mode: 'real', timeout: 120 },
  platform_toolsets: { cli: ['terminal', 'file'], telegram: ['terminal', 'file', 'memory'] },
  gateway: { unauthorized_dm_behavior: user ? 'ignore' : 'pair',
    platforms: { telegram: { enabled: true, extra: { drop_pending_on_cold_boot: false, dm_policy: user ? 'allowlist' : 'pairing', allow_from: user ? [user] : [], group_policy: 'disabled', guest_mode: false } } } },
};
const python = `import sys,json,os,pathlib\nimport yaml\nos.umask(0o077)\np=pathlib.Path('/home/node/.hermes');p.mkdir(exist_ok=True)\nd=json.load(sys.stdin)\n(p/'.env').write_text(d['env'])\nc=p/'config.yaml'\nconfig=yaml.safe_load(c.read_text()) if c.exists() else d['config']\nif d['restrict']: config['gateway']=d['config']['gateway']\nc.write_text(json.dumps(config,indent=2))\nprint('Private Hermes configuration installed')`;
const result = spawnSync('docker', ['exec', '-i', metadata.container, '/opt/hermes/.venv/bin/python', '-c', python], {
  input: JSON.stringify({ env: `OPENROUTER_API_KEY=${key}\nTELEGRAM_BOT_TOKEN=${token}\n${user ? `TELEGRAM_ALLOWED_USERS=${user}\n` : ''}`, config, restrict: Boolean(user) }), encoding: 'utf8',
});
if (result.status !== 0) throw Error('Private credential installation failed');
console.log('Hermes workspace prepared:', workspace.id);
const services = await sandbox({ method: 'services', id: workspace.id });
let service = services.find(service => service.name === 'hermes-gateway');
if (!service) service = await sandbox({ method: 'startService', id: workspace.id, options: {
  name: 'hermes-gateway', command: 'exec hermes gateway run',
  restart: { policy: 'always', maxRestarts: 100, delayMs: 10000 },
} });
console.log('Hermes service:', service.id, service.status);
