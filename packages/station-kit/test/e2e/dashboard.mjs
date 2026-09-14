import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const { chromium } = createRequire(import.meta.resolve('station-browser-use'))('playwright');
const here = fileURLToPath(new URL('.', import.meta.url));
const kitRoot = resolve(here, '../..');
const nextServer = join(kitRoot, '.next/standalone/packages/station-kit/server.js');
const workerScript = join(here, 'fixtures/execution-station.mjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function until(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}
async function within(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
function processHandle(executable, args, options) {
  const child = spawn(executable, args, options);
  let output = '';
  child.stdout?.on('data', (chunk) => { output = (output + chunk).slice(-32_768); });
  child.stderr?.on('data', (chunk) => { output = (output + chunk).slice(-32_768); });
  const done = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, done, output: () => output };
}
async function stop(handle, ipc = false) {
  if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  if (ipc && handle.child.connected) handle.child.send('stop');
  else handle.child.kill('SIGTERM');
  let result;
  try { result = await within(handle.done, 8000, 'Service did not stop gracefully'); }
  catch {
    handle.child.kill('SIGKILL');
    await handle.done;
    throw new Error(`Service did not stop gracefully:\n${handle.output()}`);
  }
  if (result.error || (ipc && result.code !== 0)) throw new Error(`Service shutdown failed:\n${handle.output()}`);
}
async function selectOption(page, label, value) {
  await until(async () => (await page.getByRole('combobox', { name: label, exact: true }).locator('option').evaluateAll((options) => options.map((option) => option.value))).includes(value), `option ${label}: ${value}`);
  await page.getByRole('combobox', { name: label, exact: true }).selectOption(value);
}
async function command(page, value, expected) {
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(value);
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await until(async () => expected.test(await page.getByLabel('Command output', { exact: true }).innerText()), `command output ${expected}`, 60_000);
}
async function browserAction(page, action, value = '', expected) {
  await page.getByRole('combobox', { name: 'Browser action', exact: true }).selectOption(action);
  if (action !== 'screenshot') await page.getByRole('textbox', { name: 'Action value', exact: true }).fill(value);
  const response = page.waitForResponse((response) => response.url().endsWith('/execution/browser') && response.request().method() === 'POST' && response.request().postDataJSON()?.method === 'action');
  await page.getByRole('button', { name: 'Run browser action', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  if (expected) await until(async () => expected.test(await page.getByLabel('Browser result', { exact: true }).innerText()), `browser result ${expected}`);
}

test('real dashboard controls private sandbox and Bun/Playwright workers; custom installs survive worker restart', { timeout: 240_000 }, async (t) => {
  assert.ok(existsSync(nextServer), 'Build station-kit, including its dashboard, before running E2E.');
  assert.ok(existsSync(join(kitRoot, 'dist/server/index.js')), 'Build Station packages first.');
  const root = mkdtempSync(join(tmpdir(), 'station-dashboard-e2e-'));
  const artifacts = process.env.STATION_E2E_ARTIFACTS ? resolve(process.env.STATION_E2E_ARTIFACTS) : mkdtempSync(join(tmpdir(), 'station-dashboard-e2e-artifacts-'));
  mkdirSync(artifacts, { recursive: true });
  const networkPath = join(root, 'network.db');
  const tablePrefix = `station_e2e_${randomBytes(8).toString('hex')}`;
  const checks = [];
  const record = (description) => { checks.push(description); console.log(`[dashboard-e2e] ${description}`); };
  const token = randomBytes(32).toString('hex');
  const password = randomBytes(16).toString('hex');
  const services = new Map();
  let dashboard;
  let context;
  let browser;
  let fixture;
  let page;
  let failed = true;
  const pageErrors = [];
  const startWorker = async (id, primitive, config = {}) => {
    const options = { id, primitive, networkPath, tablePrefix, token, password, cwd: join(root, id), port: await port(), ...config };
    const handle = processHandle(process.execPath, [workerScript], {
      cwd: kitRoot, env: { ...process.env, STATION_E2E_OPTIONS: JSON.stringify(options) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    services.set(id, handle);
    await within(Promise.race([
      new Promise((resolve) => handle.child.on('message', (message) => { if (message.ready) resolve(); })),
      handle.done.then(() => { throw new Error(`Station ${id} exited before readiness:\n${handle.output()}`); }),
    ]), 30_000, `Station ${id} readiness timeout`);
    return options;
  };
  t.after(async () => {
    if (failed && page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    await context?.close();
    await browser?.close();
    const results = await Promise.allSettled([...services.values()].map((service) => stop(service, true)));
    await stop(dashboard).catch((error) => { results.push({ status: 'rejected', reason: error }); });
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    if (process.env.STATION_E2E_DATABASE_URL) {
      const pg = createRequire(new URL('../../../station-adapter-postgres/package.json', import.meta.url))('pg');
      const pool = new pg.Pool({ connectionString: process.env.STATION_E2E_DATABASE_URL });
      try { await pool.query(`DROP TABLE IF EXISTS ${tablePrefix}_stations, ${tablePrefix}_controller_leases`); }
      finally { await pool.end(); }
    }
    writeFileSync(join(artifacts, 'summary.json'), JSON.stringify({ passed: !failed && results.every((result) => result.status === 'fulfilled'), database: process.env.STATION_E2E_DATABASE_URL ? 'postgres' : 'sqlite', checks, dashboardErrors: pageErrors }, null, 2));
    if (!failed) rmSync(root, { recursive: true, force: true });
    console.log(`[dashboard-e2e] artifacts: ${artifacts}`);
    if (failed) console.log(`[dashboard-e2e] retained fixture data: ${root}`);
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map((result) => result.reason), 'E2E service cleanup failed');
  });

  const packageFixture = join(here, 'fixtures/custom-tool');
  const packed = processHandle('npm', ['pack', packageFixture, '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: root, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const packedExit = await packed.done;
  assert.equal(packedExit.code, 0, packed.output());
  const tarball = join(root, 'station-dashboard-e2e-tool-1.0.0.tgz');
  assert.ok(existsSync(tarball));

  fixture = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><title>Station browser E2E</title></head><body><h1>Browser fixture</h1><input id="entry"><button id="apply" onclick="document.querySelector('#result').textContent=document.querySelector('#entry').value">Apply</button><p id="result"></p></body></html>`);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  const nextPort = await port();
  dashboard = processHandle(process.execPath, [nextServer], { cwd: kitRoot, env: { ...process.env, PORT: String(nextPort), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${nextPort}/sandboxes`)).status === 200; } catch { return false; } }, 'Next dashboard startup');
  const sandboxOptions = await startWorker('sandbox-worker', 'sandbox');
  await startWorker('bun-worker', 'bun');
  await startWorker('playwright-worker', 'playwright');
  const hq = await startWorker('hq', undefined, { nextPort });
  const base = `http://127.0.0.1:${hq.port}`;

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('dialog', (dialog) => { void dialog.accept(); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/sandboxes`);
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('e2e');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Sandboxes', exact: true }).waitFor();
  const discovery = await context.request.get(`${base}/api/v1/execution`);
  assert.equal(discovery.status(), 200);
  await selectOption(page, 'Sandbox station', 'sandbox-worker');
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await until(async () => !!(await page.getByRole('combobox', { name: 'Workspace', exact: true }).inputValue()), 'created workspace');
  const workspace = await page.getByRole('combobox', { name: 'Workspace', exact: true }).inputValue();
  await command(page, `npm install --global --offline --ignore-scripts --no-audit --no-fund ${shellQuote(tarball)} && printf '\\nINSTALL_FINISHED\\n'`, /INSTALL_FINISHED/);
  await command(page, 'station-e2e-tool fresh-command', /STATION_CUSTOM_TOOL_OK:fresh-command/);
  await page.screenshot({ path: join(artifacts, 'sandbox-installed-tool.png'), fullPage: true });
  record('UI login, workspace creation, offline npm install and fresh-command CLI invocation passed');

  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  await until(async () => { const value = await page.getByRole('combobox', { name: 'Workspace', exact: true }).inputValue(); return value && value !== workspace; }, 'second isolated home');
  await command(page, 'if command -v station-e2e-tool; then printf TOOL_LEAKED; else printf TOOL_NOT_INSTALLED_HERE; fi', /TOOL_NOT_INSTALLED_HERE/);
  const secondWorkspace = await page.getByRole('combobox', { name: 'Workspace', exact: true }).inputValue();
  await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await until(async () => !existsSync(join(sandboxOptions.cwd, 'workspaces', secondWorkspace)), 'second workspace files removed');
  await stop(services.get('sandbox-worker'), true);
  services.delete('sandbox-worker');
  await startWorker('sandbox-worker', 'sandbox', { port: sandboxOptions.port });
  await page.reload();
  await page.getByRole('heading', { name: 'Sandboxes', exact: true }).waitFor();
  await selectOption(page, 'Sandbox station', 'sandbox-worker');
  await selectOption(page, 'Workspace', workspace);
  await command(page, 'station-e2e-tool after-restart', /STATION_CUSTOM_TOOL_OK:after-restart/);
  await page.screenshot({ path: join(artifacts, 'sandbox-after-worker-restart.png'), fullPage: true });
  record('Custom install stayed out of a second workspace and survived owner process restart');

  await command(page, 'printf EXPECTED_COMMAND_FAILURE >&2; exit 7', /EXPECTED_COMMAND_FAILURE/);
  await until(async () => (await page.getByLabel('Command status', { exact: true }).textContent()) === 'failed', 'failed command terminal status');
  assert.match(await page.getByLabel('Command output', { exact: true }).innerText(), /\[stderr\]/);
  await page.getByText('Exit 7', { exact: true }).waitFor();
  await command(page, 'printf CANCEL_STARTED; sleep 30', /CANCEL_STARTED/);
  await page.getByRole('button', { name: 'Cancel command', exact: true }).click();
  await until(async () => (await page.getByLabel('Command status', { exact: true }).textContent()) === 'cancelled', 'command cancellation');
  await page.getByRole('spinbutton', { name: 'Timeout (seconds)', exact: true }).fill('1');
  await command(page, 'printf TIMEOUT_STARTED; sleep 20', /TIMEOUT_STARTED/);
  await until(async () => (await page.getByLabel('Command status', { exact: true }).textContent()) === 'timed_out', 'command timeout');
  await page.getByRole('spinbutton', { name: 'Timeout (seconds)', exact: true }).fill('30');
  await page.screenshot({ path: join(artifacts, 'sandbox-command-timeout.png'), fullPage: true });
  record('Failed command exposes stderr/exit code; cancellation and configured timeout settle running commands');

  await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await page.getByText('No workspaces on this station. Create one to run a command.', { exact: true }).waitFor();
  assert.equal(existsSync(join(sandboxOptions.cwd, 'workspaces', workspace)), false);
  record('Deleting the original workspace removes its installed tool and workspace files');

  await page.goto(`${base}/browser-use`);
  await page.getByRole('heading', { name: 'Browser Use', exact: true }).waitFor();
  for (const owner of ['bun-worker', 'playwright-worker']) {
    await selectOption(page, 'Browser station', owner);
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    await until(async () => !!(await page.getByRole('combobox', { name: 'Browser session', exact: true }).inputValue()), `${owner} browser session`);
    await browserAction(page, 'navigate', fixtureUrl);
    await browserAction(page, 'click', '#entry');
    await browserAction(page, 'type', `input-${owner}x`);
    await browserAction(page, 'press', 'Backspace');
    await browserAction(page, 'click', '#apply');
    await browserAction(page, 'evaluate', "document.querySelector('#result').textContent", new RegExp(`input-${owner}`));
    await browserAction(page, 'screenshot');
    const image = page.getByRole('img', { name: 'Browser screenshot', exact: true });
    await image.waitFor();
    assert.match(await image.getAttribute('src'), /^data:image\/png;base64,iVBOR/);
    await until(() => image.evaluate((element) => element.complete && element.naturalWidth > 0), `${owner} PNG rendered`);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download screenshot', exact: true }).click();
    const download = await downloaded;
    const downloadedPng = join(artifacts, `${owner}-download.png`);
    await download.saveAs(downloadedPng);
    assert.deepEqual([...readFileSync(downloadedPng).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'download contains real PNG bytes');
    await page.screenshot({ path: join(artifacts, `${owner}-screenshot.png`), fullPage: true });
    await page.getByRole('combobox', { name: 'Browser action', exact: true }).selectOption('evaluate');
    await page.getByRole('textbox', { name: 'Action value', exact: true }).fill('new Promise(() => {})');
    const pendingAction = page.waitForResponse((response) => response.url().endsWith('/execution/browser') && response.request().method() === 'POST' && response.request().postDataJSON()?.method === 'action');
    await page.getByRole('button', { name: 'Run browser action', exact: true }).click();
    await page.getByText('Browser operation in progress…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close browser', exact: true }).click();
    assert.equal((await pendingAction).status(), 503, 'closing cancels the pending browser operation');
    await page.getByText('No live browser sessions on this station. Open a browser to begin.', { exact: true }).waitFor();
    record(`${owner} UI navigation/input/keypress/evaluation/PNG download and close during pending evaluation passed`);
  }
  assert.deepEqual(pageErrors, [], `Unexpected dashboard JavaScript errors: ${pageErrors.join('; ')}`);
  failed = false;
});
