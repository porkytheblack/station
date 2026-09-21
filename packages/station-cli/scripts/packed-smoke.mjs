#!/usr/bin/env node
// Explicit integration check: packs local code and installs under a fresh OS temp directory.
// Never publishes packages. Requires prebuilt packages, npm network/cache access and loopback ports.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'station-packed-'));
const archives = join(scratch, 'archives'); await mkdir(archives);
const manifests = new Map();
for (const dir of await readdir(join(repo, 'packages'))) {
  try { const data = JSON.parse(await readFile(join(repo, 'packages', dir, 'package.json'), 'utf8')); if (!data.private) manifests.set(data.name, { data, dir: join(repo, 'packages', dir) }); } catch {}
}
function closure(roots) {
  const packages = new Set();
  function visit(name) { if (packages.has(name)) return; const entry = manifests.get(name); if (!entry) return; packages.add(name); for (const dependency of Object.keys({ ...entry.data.dependencies, ...entry.data.peerDependencies })) visit(dependency); }
  roots.forEach(visit); return [...packages];
}
async function command(executable, args, { cwd = scratch, env = {}, input, timeout = 180_000 } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolveCommand(stdout); else reject(new Error(`${executable} ${args[0] ?? ''} failed (${code})\n${stdout.slice(-6000)}\n${stderr.slice(-6000)}`)); });
    child.stdin.end(input);
  });
}
async function freePort() {
  const server = createServer(); await new Promise((resolvePort, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePort); });
  const port = server.address().port; await new Promise(resolvePort => server.close(resolvePort)); return port;
}
async function waitUnavailable(url) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(300) }); await response.body?.cancel(); }
    catch { return; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Stopped local service still accepts HTTP connections.');
}
const tarballs = new Map();
const daemonNames = closure(['station-daemon', 'station-runtime-cli']);
const allNames = closure(['station-daemon', 'station-runtime-cli', 'station-dashboard']);
console.log(`Packing ${allNames.length} local packages into ${scratch}`);
for (const name of allNames) {
  const { data, dir } = manifests.get(name);
  assert.equal(data.version, '3.0.0');
  await command('pnpm', ['pack', '--pack-destination', archives], { cwd: dir });
  const tarball = join(archives, `${name.replace('@', '').replace('/', '-')}-${data.version}.tgz`);
  assert.ok((await stat(tarball)).size > 0); tarballs.set(name, tarball);
}
async function install(directory, names) {
  await mkdir(directory);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: Object.fromEntries(names.map(name => [name, `file:${tarballs.get(name)}`])) }));
  await command('npm', ['install', '--no-audit', '--no-fund'], { cwd: directory, timeout: 240_000 });
}
const daemonRoot = join(scratch, 'headless'); const dashboardRoot = join(scratch, 'dashboard');
await install(daemonRoot, daemonNames);
for (const forbidden of ['next', 'react', 'react-dom', 'station-dashboard', 'station-kit']) {
  await assert.rejects(stat(join(daemonRoot, 'node_modules', forbidden)), { code: 'ENOENT' });
}
console.log('Headless install contains no Next, React, dashboard or StationKit.');
await install(dashboardRoot, closure(['station-dashboard', 'station-runtime-cli']));
await assert.rejects(stat(join(dashboardRoot, 'node_modules', 'station-daemon')), { code: 'ENOENT' });
const packagedServer = join(dashboardRoot, 'node_modules/station-dashboard/.next/standalone/packages/station-dashboard/server.js');
assert.ok((await stat(packagedServer)).isFile());
assert.ok((await stat(join(dashboardRoot, 'node_modules/station-dashboard/.next/standalone/packages/station-dashboard/.next/static'))).isDirectory());
console.log('Dashboard archive contains its standalone server and static assets, with no daemon dependency.');
const daemonPort = await freePort(), dashboardPort = await freePort();
const daemonURL = `http://127.0.0.1:${daemonPort}`, dashboardURL = `http://127.0.0.1:${dashboardPort}`;
const cliHome = join(scratch, 'cli-state');
const password = randomBytes(20).toString('hex');
await mkdir(join(daemonRoot, 'signals'));
await writeFile(join(daemonRoot, 'signals', 'echo.ts'), `import { signal,z } from 'station-signal'; export const echo = signal('packed-echo').input(z.object({message:z.string()})).output(z.object({message:z.string()})).run(async input => input);\n`);
await writeFile(join(daemonRoot, 'station.config.ts'), `import { defineConfig } from 'station-daemon'; export default defineConfig({host:'127.0.0.1',signalsDir:'./signals',stationDir:'./station-data',auth:{username:'packed-test',password:${JSON.stringify(password)}},network:{stationId:'packed-daemon'}});\n`, { mode: 0o600 });
const cli = (root, args, input) => command(process.execPath, [join(root, 'node_modules/station-runtime-cli/dist/cli.js'), ...args], { cwd: root, env: { STATION_CLI_HOME: cliHome }, input });
await writeFile(join(scratch, 'image.mjs'), "console.log('compiled artifact');\n");
await writeFile(join(scratch, 'image-template.json'), JSON.stringify({ format: 'station.image/v1', protocol: 'station.process/v1', name: 'packed/echo', version: '1.0.0', artifacts: [{ entrypoint: 'image.mjs', runtime: 'node', runtimeMajor: 22, platform: { os: 'any', arch: 'any' } }], exports: [{ name: 'echo', kind: 'signal' }] }));
const bundle = JSON.parse(await cli(daemonRoot, ['images', 'build', join(scratch, 'image-template.json'), '--artifacts-dir', scratch, '--out', join(scratch, 'image-bundle')]));
assert.equal(JSON.parse(await cli(daemonRoot, ['images', 'validate', bundle.manifest, '--artifacts-dir', bundle.artifactsDirectory])).valid, true);
console.log('Installed CLI builds and validates precompiled image bundles offline without a context.');
let daemonStarted = false, dashboardStarted = false;
try {
  const started = JSON.parse(await cli(daemonRoot, ['daemon', 'start', '--instance', 'packed', '--config', 'station.config.ts', '--port', String(daemonPort)])); daemonStarted = true;
  assert.equal(started.status, 'running'); assert.equal(started.apiReady, true);
  const status = JSON.parse(await cli(daemonRoot, ['daemon', 'status', '--instance', 'packed'])); assert.equal(status.status, 'running');
  const login = await fetch(daemonURL + '/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'packed-test', password }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const keyReply = await fetch(daemonURL + '/api/v1/keys', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'packed-smoke', scopes: ['read', 'trigger', 'cancel', 'admin'] }) });
  assert.equal(keyReply.status, 201); const key = (await keyReply.json()).data.key;
  await cli(daemonRoot, ['context', 'add', 'packed', '--url', daemonURL, '--identity', 'packed-daemon', '--token-stdin'], key);
  const connected = JSON.parse(await cli(daemonRoot, ['status'])); assert.equal(connected.info.protocol, 'station.api/v1'); assert.equal(connected.info.stationId, 'packed-daemon');
  const run = JSON.parse(await cli(daemonRoot, ['signal', 'run', 'packed-echo', '--input', '{"message":"installed outside workspace"}']));
  let finished;
  for (let i = 0; i < 80; i++) { finished = (await (await fetch(`${daemonURL}/api/v1/runs/${run.id}`, { headers: { authorization: `Bearer ${key}` } })).json()).data; if (finished?.status === 'completed' || finished?.status === 'failed') break; await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  assert.equal(finished?.status, 'completed', finished?.error); assert.deepEqual(JSON.parse(finished.output), { message: 'installed outside workspace' });
  console.log('Installed CLI exits while daemon stays alive; authenticated signal runs complete in the packed daemon.');
  const dashboard = JSON.parse(await cli(dashboardRoot, ['dashboard', 'start', '--instance', 'packed', '--port', String(dashboardPort), '--context', 'packed'])); dashboardStarted = true;
  assert.equal(dashboard.status, 'running'); assert.equal(dashboard.apiReady, true);
  const page = await fetch(dashboardURL); assert.equal(page.status, 200); assert.match(await page.text(), /Station/);
  const proxied = await fetch(dashboardURL + '/api/v1/info', { headers: { authorization: `Bearer ${key}` } }); assert.equal(proxied.status, 200); assert.equal((await proxied.json()).data.stationId, 'packed-daemon');
  await cli(dashboardRoot, ['dashboard', 'stop', '--instance', 'packed']); dashboardStarted = false;
  await waitUnavailable(dashboardURL);
  const alive = JSON.parse(await cli(daemonRoot, ['status'])); assert.equal(alive.health.ok, true);
  console.log('Packed standalone dashboard proxies the chosen daemon; stopping it leaves the daemon available.');
  await cli(daemonRoot, ['daemon', 'stop', '--instance', 'packed']); daemonStarted = false;
  await waitUnavailable(daemonURL);
  console.log(`Packed-install smoke passed. Private test artifacts remain at ${scratch}`);
} finally {
  if (dashboardStarted) await cli(dashboardRoot, ['dashboard', 'stop', '--instance', 'packed']).catch(() => {});
  if (daemonStarted) await cli(daemonRoot, ['daemon', 'stop', '--instance', 'packed']).catch(() => {});
  // These files contain temporary auth material. Keep packages/logs for diagnosis, remove credentials.
  await rm(join(daemonRoot, 'station.config.ts'), { force: true });
  await rm(join(cliHome, 'contexts.json'), { force: true });
}
