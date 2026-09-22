import { existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stateDir } from './shared.mjs';
export function ensureTLS() {
  const key = `${stateDir}/tls-key.pem`, cert = `${stateDir}/tls-cert.pem`;
  if (existsSync(key) && existsSync(cert)) return;
  if (existsSync(key) || existsSync(cert)) throw Error('Incomplete TLS identity; refusing to overwrite it.');
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '365',
    '-subj', '/CN=station', '-addext', 'subjectAltName=DNS:station', '-keyout', key, '-out', cert], { stdio: 'pipe' });
  chmodSync(key, 0o600); chmodSync(cert, 0o644);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureTLS(); console.log('Private Compose TLS identity prepared; certificate expires in one year.');
}
