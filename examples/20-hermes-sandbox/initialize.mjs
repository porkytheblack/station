import { mkdirSync, chmodSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stateDir } from './shared.mjs';
import { ensureTLS } from './tls.mjs';
const [image, seccomp] = process.argv.slice(2);
if (!image || !seccomp || image.startsWith('-')) throw Error('Usage: initialize.mjs IMAGE SECCOMP_JSON_PATH');
mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
if (existsSync(`${stateDir}/settings.json`)) throw Error('Already initialized; existing settings were preserved.');
const imageId = execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
copyFileSync(seccomp, `${stateDir}/seccomp.json`); chmodSync(`${stateDir}/seccomp.json`, 0o600);
const settings = { image: imageId, username: process.env.STATION_ADMIN_USERNAME ?? 'operator',
  password: randomBytes(20).toString('base64url'), executionToken: randomBytes(32).toString('hex'),
};
writeFileSync(`${stateDir}/settings.json`, JSON.stringify(settings, null, 2), { mode: 0o600 });
writeFileSync(`${stateDir}/dashboard-login.txt`, `Dashboard: http://127.0.0.1:5801\nUsername: ${settings.username}\nPassword: ${settings.password}\n`, { mode: 0o600 });
console.log(`Initialized private settings at ${stateDir}/settings.json`);
ensureTLS();
