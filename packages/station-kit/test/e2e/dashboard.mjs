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
import { browserGapFlow } from './browser-gap-flow.mjs';

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
  if (label === 'Sandbox station' || label === 'Browser station') {
    const section = label === 'Sandbox station' ? 'sandboxes' : 'browser-use';
    await page.waitForURL(`**/${section}/${encodeURIComponent(value)}`);
  }
}
async function resourceId(page, kind) {
  const attribute = kind === 'workspace' ? 'data-workspace-id' : 'data-browser-session-id';
  const detail = page.locator(`[${attribute}]`);
  await detail.waitFor();
  const id = await detail.getAttribute(attribute);
  assert.ok(new URL(page.url()).pathname.includes(`/${id}/`), 'resource identity is addressable in the URL');
  return id;
}
async function toolPage(page, label) {
  await page.getByRole('navigation', { name: /Workspace tools|Browser session tools|Browser collections/ }).getByRole('link', { name: label, exact: true }).click();
  await until(async () => (await page.getByRole('navigation', { name: /Workspace tools|Browser session tools|Browser collections/ }).getByRole('link', { name: label, exact: true }).getAttribute('aria-current')) === 'page', `${label} route active`);
}
async function command(page, value, expected) {
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill(value);
  await page.getByRole('button', { name: 'Run command', exact: true }).click();
  await until(async () => expected.test(await page.getByLabel('Command output', { exact: true }).innerText()), `command output ${expected}`, 60_000);
}
async function browserAction(page, action, value = '', expected) {
  if (!new URL(page.url()).pathname.endsWith('/control')) await toolPage(page, 'Control');
  await page.getByRole('combobox', { name: 'Browser action', exact: true }).selectOption(action);
  if (action !== 'screenshot') await page.getByRole('textbox', { name: 'Action value', exact: true }).fill(value);
  const response = page.waitForResponse((response) => response.url().endsWith('/execution/browser') && response.request().method() === 'POST' && response.request().postDataJSON()?.method === 'action');
  await page.getByRole('button', { name: 'Run browser action', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  if (expected) await until(async () => expected.test(await page.getByLabel('Browser result', { exact: true }).innerText()), `browser result ${expected}`);
}

test('real dashboard controls private sandbox and Bun/Playwright workers; custom installs survive worker restart', { timeout: 420_000 }, async (t) => {
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
    if (failed && page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
    for (const [id, service] of services) writeFileSync(join(artifacts, `${id}.log`), service.output());
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

  fixture = createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="station-result.txt"' });
      response.end('STATION_BROWSER_DOWNLOAD_OK');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><head><title>Station browser E2E</title></head><body><h1>Browser fixture</h1><input id="entry"><button id="apply" onclick="document.querySelector('#result').textContent=document.querySelector('#entry').value">Apply</button><p id="result"></p><select id="choice"><option value="one">One</option><option value="two">Two</option></select><input id="checked" type="checkbox"><input id="upload" type="file"><a id="download" href="/download">Download result</a></body></html>`);
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
  const nextPort = await port();
  dashboard = processHandle(process.execPath, [nextServer], { cwd: kitRoot, env: { ...process.env, PORT: String(nextPort), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${nextPort}/sandboxes`)).status === 200; } catch { return false; } }, 'Next dashboard startup');
  const sandboxOptions = await startWorker('sandbox-worker', 'sandbox');
  const browserWorkers = new Map();
  browserWorkers.set('bun-worker', await startWorker('bun-worker', 'bun'));
  browserWorkers.set('playwright-worker', await startWorker('playwright-worker', 'playwright'));
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
  const workspace = await resourceId(page, 'workspace');
  assert.equal(await page.getByRole('button', { name: 'Create workspace', exact: true }).count(), 0, 'detail does not repeat collection controls');
  await command(page, `npm install --global --offline --ignore-scripts --no-audit --no-fund ${shellQuote(tarball)} && printf '\\nINSTALL_FINISHED\\n'`, /INSTALL_FINISHED/);
  await command(page, 'station-e2e-tool fresh-command', /STATION_CUSTOM_TOOL_OK:fresh-command/);
  await page.screenshot({ path: join(artifacts, 'sandbox-installed-tool.png'), fullPage: true, animations: 'disabled' });
  record('UI login, workspace creation, offline npm install and fresh-command CLI invocation passed');

  await page.getByRole('link', { name: '← All workspaces', exact: true }).click();
  await page.getByRole('link', { name: `Open workspace ${workspace}`, exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Command', exact: true }).count(), 0, 'collection does not mount command controls');
  await page.screenshot({ path: join(artifacts, 'sandbox-workspace-list.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
  assert.notEqual(await resourceId(page, 'workspace'), workspace);
  await command(page, 'if command -v station-e2e-tool; then printf TOOL_LEAKED; else printf TOOL_NOT_INSTALLED_HERE; fi', /TOOL_NOT_INSTALLED_HERE/);
  const secondWorkspace = await resourceId(page, 'workspace');
  await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await until(async () => !existsSync(join(sandboxOptions.cwd, 'workspaces', secondWorkspace)), 'second workspace files removed');
  await stop(services.get('sandbox-worker'), true);
  services.delete('sandbox-worker');
  await startWorker('sandbox-worker', 'sandbox', { port: sandboxOptions.port });
  await page.reload();
  await page.getByRole('heading', { name: 'Sandboxes', exact: true }).waitFor();
  await selectOption(page, 'Sandbox station', 'sandbox-worker');
  await page.getByRole('link', { name: `Open workspace ${workspace}`, exact: true }).click();
  await command(page, 'station-e2e-tool after-restart', /STATION_CUSTOM_TOOL_OK:after-restart/);
  await page.screenshot({ path: join(artifacts, 'sandbox-after-worker-restart.png'), fullPage: true, animations: 'disabled' });
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
  await page.screenshot({ path: join(artifacts, 'sandbox-command-timeout.png'), fullPage: true, animations: 'disabled' });
  record('Failed command exposes stderr/exit code; cancellation and configured timeout settle running commands');

  const sandboxRpc = async (body) => {
    const response = await context.request.post(`${base}/api/v1/stations/sandbox-worker/execution/sandbox`, { data: { id: workspace, ...body } });
    assert.equal(response.status(), 200, await response.text());
    return (await response.json()).data;
  };
  await toolPage(page, 'Terminal');
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await until(async () => !!(await page.getByRole('combobox', { name: 'Terminal session', exact: true }).inputValue()), 'interactive terminal created');
  const terminalId = await page.getByRole('combobox', { name: 'Terminal session', exact: true }).inputValue();
  const terminalInput = page.getByLabel('Sandbox terminal input', { exact: true });
  await terminalInput.pressSequentially('station-e2e-tool terminal-input');
  await terminalInput.press('Enter');
  await until(async () => (await sandboxRpc({ method: 'terminal', terminalId, offset: 0 })).data.includes('STATION_CUSTOM_TOOL_OK:terminal-input'), 'installed CLI in real xterm PTY');
  await page.getByRole('button', { name: 'Reconnect terminal', exact: true }).click();
  await terminalInput.pressSequentially('station-e2e-tool reconnected');
  await terminalInput.press('Enter');
  await until(async () => (await sandboxRpc({ method: 'terminal', terminalId, offset: 0 })).data.includes('STATION_CUSTOM_TOOL_OK:reconnected'), 'same PTY accepts input after reconnect');
  assert.equal(await page.getByRole('combobox', { name: 'Terminal session', exact: true }).inputValue(), terminalId);
  await page.screenshot({ path: join(artifacts, 'sandbox-interactive-terminal.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nested page fits phone width');
  await until(async () => (await sandboxRpc({ method: 'terminal', terminalId, offset: 0 })).cols < 90, 'terminal resize reaches real PTY');
  await page.screenshot({ path: join(artifacts, 'sandbox-terminal-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await until(async () => (await sandboxRpc({ method: 'terminal', terminalId, offset: 0 })).status === 'exited', 'terminal close');
  record('Real xterm input, installed CLI, reconnect to same terminal, responsive resize and close passed');

  await toolPage(page, 'Commands');
  await command(page, `node -e ${shellQuote("require('node:fs').writeFileSync('chunks.txt','x'.repeat(1048576+17));console.log('CHUNK_FILE_READY')")}`, /CHUNK_FILE_READY/);
  await toolPage(page, 'Files');
  const filesUrl = page.url();
  assert.equal(await page.getByRole('textbox', { name: 'Command', exact: true }).count(), 0);
  await page.goBack();
  await page.getByRole('textbox', { name: 'Command', exact: true }).waitFor();
  await page.goForward();
  assert.equal(page.url(), filesUrl);
  await page.reload();
  await page.getByRole('textbox', { name: 'Workspace file path', exact: true }).waitFor();
  assert.equal(page.url(), filesUrl, 'files deep link survives refresh and browser history');
  await page.getByRole('button', { name: 'chunks.txt', exact: true }).click();
  await until(async () => (await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue()).length === 1048576 + 17, 'file preview reads multiple worker-size chunks');
  await page.getByRole('textbox', { name: 'Workspace file path', exact: true }).fill('empty.txt');
  await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).fill('');
  await page.getByRole('button', { name: 'Save text file', exact: true }).click();
  await page.getByRole('button', { name: 'empty.txt', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).fill('must be replaced by empty file');
  await page.getByRole('button', { name: 'empty.txt', exact: true }).click();
  await until(async () => (await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue()) === '', 'empty file preview handles EOF');
  await page.getByRole('textbox', { name: 'Workspace file path', exact: true }).fill('notes.txt');
  await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).fill('STATION_FILE_UI_OK — saved from dashboard');
  await page.getByRole('button', { name: 'Save text file', exact: true }).click();
  await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).fill('');
  await page.getByRole('button', { name: 'notes.txt', exact: true }).click();
  await until(async () => (await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue()).includes('STATION_FILE_UI_OK'), 'saved file read through UI');
  const uploadedBytes = Buffer.from('STATION_FILE_UPLOAD_OK\n');
  await page.getByLabel('Upload workspace file', { exact: true }).setInputFiles({ name: 'uploaded.txt', mimeType: 'text/plain', buffer: uploadedBytes });
  await page.getByRole('button', { name: 'uploaded.txt', exact: true }).click();
  await until(async () => (await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue()) === uploadedBytes.toString(), 'uploaded file read through UI');
  await page.screenshot({ path: join(artifacts, 'sandbox-files.png'), fullPage: true, animations: 'disabled' });
  const fileDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download file', exact: true }).click();
  await (await fileDownload).saveAs(join(artifacts, 'workspace-uploaded.txt'));
  assert.deepEqual(readFileSync(join(artifacts, 'workspace-uploaded.txt')), uploadedBytes);
  await sandboxRpc({ method: 'writeFile', path: 'src/example.ts', options: { base64: Buffer.from('export const station = true;\n').toString('base64'), createParents: true } });
  await sandboxRpc({ method: 'writeFile', path: '.hidden-note', options: { base64: Buffer.from('hidden').toString('base64') } });
  await sandboxRpc({ method: 'writeFile', path: 'binary.dat', options: { base64: Buffer.from([0, 255, 1, 2]).toString('base64') } });
  await page.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await page.getByRole('button', { name: 'src/', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Filter files', exact: true }).fill('no-such-file');
  await page.getByText('No files match this filter.', { exact: true }).waitFor();
  await page.getByRole('searchbox', { name: 'Filter files', exact: true }).fill('');
  await page.getByRole('checkbox', { name: 'Hidden files', exact: true }).uncheck();
  assert.equal(await page.getByRole('button', { name: '.hidden-note', exact: true }).count(), 0);
  await page.getByRole('checkbox', { name: 'Hidden files', exact: true }).check();
  await page.getByRole('button', { name: '.hidden-note', exact: true }).waitFor();
  await page.getByRole('button', { name: 'src/', exact: true }).click();
  await page.getByRole('button', { name: 'example.ts', exact: true }).click();
  await until(async () => (await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue()).includes('export const'), 'nested text file opens');
  await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).fill('unsaved edits');
  await page.getByText('Unsaved changes', { exact: true }).waitFor();
  // Reject the discard prompt once: switching files must preserve the buffer.
  page.removeAllListeners('dialog');
  page.once('dialog', dialog => void dialog.dismiss());
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue(), 'unsaved edits');
  page.on('dialog', dialog => void dialog.accept());
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await until(async () => (await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).inputValue()).includes('export const'), 'discard restores saved text');
  await page.screenshot({ path: join(artifacts, 'sandbox-explorer-nested.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'file explorer fits phone width');
  await page.screenshot({ path: join(artifacts, 'sandbox-explorer-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('navigation', { name: 'Directory breadcrumbs', exact: true }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'binary.dat', exact: true }).click();
  await page.getByRole('heading', { name: 'Binary file', exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Workspace file content', exact: true }).count(), 0, 'binary bytes never enter the editor');
  assert.equal(await page.getByRole('button', { name: 'Save text file', exact: true }).count(), 0);
  const binaryDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download file', exact: true }).click();
  await (await binaryDownload).saveAs(join(artifacts, 'binary.dat'));
  assert.deepEqual(readFileSync(join(artifacts, 'binary.dat')), Buffer.from([0, 255, 1, 2]));
  await page.getByRole('navigation', { name: 'Directory breadcrumbs', exact: true }).getByRole('button', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'binary.dat', exact: true }).waitFor();
  record('File explorer supports nested folders, breadcrumbs, filters, hidden files, unsaved-change protection and binary downloads on desktop/mobile');
  record('Workspace file save, read, upload and download preserve bytes through Headquarters');

  const serviceControl = async (label, method) => {
    const pending = page.waitForResponse(response => response.url().endsWith('/execution/sandbox') && response.request().postDataJSON()?.method === method);
    await page.getByRole('button', { name: label, exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 200, `${method}: ${await response.text()}\n${services.get('sandbox-worker').output()}`);
  };
  await toolPage(page, 'Services');
  const httpPort = await port();
  const serviceScript = `require('node:http').createServer((req,res)=>res.end('STATION_SERVICE_HTTP_OK')).listen(${httpPort},'127.0.0.1',()=>console.log('SERVICE_LISTENING'))`;
  await page.getByRole('textbox', { name: 'Service name', exact: true }).fill('dashboard-http');
  await page.getByRole('textbox', { name: 'Service command', exact: true }).fill(`station-e2e-tool service && node -e ${shellQuote(serviceScript)}`);
  await serviceControl('Start service', 'startService');
  const httpResponds = async () => { try { return (await (await fetch(`http://127.0.0.1:${httpPort}`)).text()) === 'STATION_SERVICE_HTTP_OK'; } catch { return false; } };
  await until(httpResponds, 'supervised service serves real HTTP');
  await until(async () => (await page.getByLabel('Service output', { exact: true }).innerText()).includes('STATION_CUSTOM_TOOL_OK:service'), 'service uses installed CLI');
  await serviceControl('Stop service', 'stopService');
  await until(async () => !(await httpResponds()), 'service stop closes port');
  await serviceControl('Restart service', 'restartService');
  await until(httpResponds, 'service restart serves HTTP');
  await page.screenshot({ path: join(artifacts, 'sandbox-services.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nested page fits phone width');
  await page.screenshot({ path: join(artifacts, 'sandbox-services-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const serviceId = await page.getByRole('combobox', { name: 'Workspace service', exact: true }).inputValue();
  await stop(services.get('sandbox-worker'), true);
  services.delete('sandbox-worker');
  await until(async () => !(await httpResponds()), 'owner shutdown stops service process');
  await startWorker('sandbox-worker', 'sandbox', { port: sandboxOptions.port });
  const serviceUrl = page.url();
  await page.reload();
  await resourceId(page, 'workspace');
  assert.equal(page.url(), serviceUrl, 'refresh retains the workspace and Services subpage');
  await selectOption(page, 'Workspace service', serviceId);
  await until(async () => (await page.getByLabel('Service status', { exact: true }).innerText()).includes('interrupted'), 'persisted service recovers interrupted without replay');
  assert.equal(await httpResponds(), false, 'interrupted service does not restart implicitly');
  await serviceControl('Restart service', 'restartService');
  await until(httpResponds, 'explicit service recovery after worker restart');
  assert.equal(Buffer.from((await sandboxRpc({ method: 'readFile', path: 'uploaded.txt' })).base64, 'base64').toString(), uploadedBytes.toString());
  await serviceControl('Stop service', 'stopService');
  await serviceControl('Remove service', 'removeService');
  await until(async () => (await sandboxRpc({ method: 'services' })).length === 0, 'service definition removed');
  record('Supervised service invokes installed tool, serves HTTP, stops, restarts, recovers explicitly after worker restart and removes through UI');

  await page.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await page.getByText('No workspaces on this station. Create one to run a command.', { exact: true }).waitFor();
  assert.equal(existsSync(join(sandboxOptions.cwd, 'workspaces', workspace)), false);
  await page.goto(`${base}/sandboxes/sandbox-worker/${workspace}/files`);
  await page.getByText('This workspace could not be found on its owner. Return to the workspace list to refresh.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Workspace file path', exact: true }).count(), 0, 'deleted deep link cannot operate on another workspace');
  record('Deleting the original workspace removes its files; stale deep links do not select another workspace');

  await page.goto(`${base}/browser-use`);
  await page.getByRole('heading', { name: 'Browser Use', exact: true }).waitFor();
  for (const owner of ['bun-worker', 'playwright-worker']) {
    await page.goto(`${base}/browser-use`);
    await selectOption(page, 'Browser station', owner);
    if (owner === 'playwright-worker') await page.getByRole('textbox', { name: 'Browser profile', exact: true }).fill('dashboard-profile');
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    await resourceId(page, 'browser');
    assert.equal(await page.getByRole('button', { name: 'Start recording', exact: true }).count(), 0, 'control page does not mount recordings');
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
    await page.screenshot({ path: join(artifacts, `${owner}-screenshot.png`), fullPage: true, animations: 'disabled' });
    const sessionId = await resourceId(page, 'browser');
    const controlUrl = page.url();
    await page.reload();
    assert.equal(await resourceId(page, 'browser'), sessionId);
    assert.equal(page.url(), controlUrl, 'browser refresh preserves owner and session');
    const browserRpc = async (body) => {
      const response = await context.request.post(`${base}/api/v1/stations/${owner}/execution/browser`, { data: body });
      assert.equal(response.status(), 200, await response.text());
      return (await response.json()).data;
    };
    if (owner === 'playwright-worker') {
      await browserGapFlow({ page, base, owner, sessionId, fixtureUrl, rpc: browserRpc, artifacts, record });
      const pageOperation = async (op, selector, value) => {
        if (!new URL(page.url()).pathname.endsWith('/tools')) await toolPage(page, 'Tools');
        await page.getByRole('combobox', { name: 'Page operation', exact: true }).selectOption(op);
        if (selector !== undefined) await page.getByRole('textbox', { name: 'Element selector', exact: true }).fill(selector);
        if (value !== undefined) await page.getByRole('textbox', { name: 'Page operation value', exact: true }).fill(value);
        const pending = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.method === 'execute' && response.request().postDataJSON()?.command?.op === op);
        await page.getByRole('button', { name: 'Run page operation', exact: true }).click();
        const response = await pending;
        assert.equal(response.status(), 200, await response.text());
      };
      await pageOperation('fill', '#entry', 'ADVANCED_FILL_OK');
      await pageOperation('select', '#choice', 'two');
      await pageOperation('check', '#checked');
      await browserAction(page, 'evaluate', "[document.querySelector('#entry').value,document.querySelector('#choice').value,document.querySelector('#checked').checked]", /ADVANCED_FILL_OK/);
      const fields = await browserRpc({ method: 'action', id: sessionId, action: 'evaluate', value: "[document.querySelector('#entry').value,document.querySelector('#choice').value,document.querySelector('#checked').checked]" });
      assert.deepEqual(fields, ['ADVANCED_FILL_OK', 'two', true]);
      await toolPage(page, 'Tools');
      await page.getByRole('textbox', { name: 'Element selector', exact: true }).fill('#upload');
      const uploadResponse = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.command?.op === 'upload');
      await page.getByLabel('Browser upload file', { exact: true }).setInputFiles({ name: 'browser-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('BROWSER_UPLOAD_OK') });
      assert.equal((await uploadResponse).status(), 200);
      const uploaded = await browserRpc({ method: 'action', id: sessionId, action: 'evaluate', value: "document.querySelector('#upload').files[0].text()" });
      assert.equal(uploaded, 'BROWSER_UPLOAD_OK');
      await pageOperation('download', '#download');
      await page.getByRole('button', { name: 'Retrieve download', exact: true }).click();
      const fileDownload = page.waitForEvent('download');
      await page.getByRole('link', { name: 'Save download', exact: true }).click();
      await (await fileDownload).saveAs(join(artifacts, 'browser-result.txt'));
      assert.equal(readFileSync(join(artifacts, 'browser-result.txt'), 'utf8'), 'STATION_BROWSER_DOWNLOAD_OK');
      await page.getByRole('button', { name: 'Delete download', exact: true }).click();
      await until(async () => !(await page.getByRole('button', { name: 'Retrieve download', exact: true }).count()), 'browser artifact deleted');
      const pageControl = async (locator, op) => {
        const pending = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.method === 'execute' && response.request().postDataJSON()?.command?.op === op);
        await locator.click();
        const response = await pending;
        assert.equal(response.status(), 200, await response.text());
        await until(() => page.getByRole('button', { name: 'Refresh pages', exact: true }).isEnabled(), `${op} UI refresh completed`);
      };
      await toolPage(page, 'Pages');
      assert.equal(await page.getByRole('combobox', { name: 'Page operation', exact: true }).count(), 0, 'pages and tools are separate');
      await page.getByRole('textbox', { name: 'New page URL', exact: true }).fill(`${fixtureUrl}/second`);
      await pageControl(page.getByRole('button', { name: 'New page', exact: true }), 'newPage');
      await until(async () => (await browserRpc({ method: 'execute', id: sessionId, command: { op: 'pages' } })).length === 2, 'second browser page');
      await pageControl(page.getByRole('button', { name: 'Station browser E2E', exact: true }), 'selectPage');
      await until(async () => (await browserRpc({ method: 'execute', id: sessionId, command: { op: 'pages' } })).find(p => p.selected)?.url === `${fixtureUrl}/`, 'select original browser page');
      await pageControl(page.getByRole('button', { name: 'Station browser E2E', exact: true }).locator('..').getByRole('button', { name: 'Close page', exact: true }), 'closePage');
      await until(async () => (await browserRpc({ method: 'execute', id: sessionId, command: { op: 'pages' } })).length === 1, 'close second page');
      await browserAction(page, 'evaluate', "localStorage.setItem('station-profile-test','PERSISTED_PROFILE_OK')");
      await page.screenshot({ path: join(artifacts, 'browser-advanced-tools.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 844 });
  await until(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'nested page fits phone width');
      await page.screenshot({ path: join(artifacts, 'browser-advanced-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      record('Playwright profile, form fill/select/check, file upload/download, page creation/selection/close passed');
    } else {
      assert.equal(await page.getByRole('region', { name: 'Advanced browser controls', exact: true }).count(), 0, 'Bun does not advertise unsupported advanced browser controls');
    }
    await toolPage(page, 'Recordings');
    await page.getByRole('button', { name: 'Start recording', exact: true }).click();
    let trace;
    await until(async () => {
      trace = (await browserRpc({ method: 'recordings' })).find((entry) => entry.sessionId === sessionId);
      return trace?.frames.length >= 1;
    }, `${owner} initial recording frame`);
    assert.equal(trace.intervalMs, 5000);
    const initialFrame = await browserRpc({ method: 'recordingFrame', id: trace.id, frameId: trace.frames[0].id });
    await page.goto(`${base}/sandboxes`);
    await browserRpc({ method: 'action', id: sessionId, action: 'evaluate', value: "(() => { document.body.style.background='rgb(30, 90, 160)'; document.querySelector('#result').textContent='RECORDED_LATER'; })()" });
    await until(async () => {
      trace = await browserRpc({ method: 'recording', id: trace.id });
      return trace.frames.length >= 2;
    }, `${owner} worker captures with dashboard away`, 15_000);
    const laterFrame = await browserRpc({ method: 'recordingFrame', id: trace.id, frameId: trace.frames[1].id });
    assert.notEqual(initialFrame.base64, laterFrame.base64, 'recording captures changed page content');
    assert.ok(Date.parse(trace.frames[1].capturedAt) - Date.parse(trace.frames[0].capturedAt) >= 4000, 'default cadence is approximately five seconds');
    await page.goto(`${base}/browser-use/${owner}/sessions/${sessionId}/recordings`);
    await selectOption(page, 'Recording selector', trace.id);
    await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
    await until(async () => (await browserRpc({ method: 'recording', id: trace.id })).status === 'stopped', `${owner} stops recording`);
    // A second recording is left active: closing the session must stop it too.
    await toolPage(page, 'Recordings');
    await page.getByRole('button', { name: 'Start recording', exact: true }).click();
    let activeTrace;
    await until(async () => {
      activeTrace = (await browserRpc({ method: 'recordings' })).find((entry) => entry.status === 'recording');
      return activeTrace?.frames.length >= 1;
    }, `${owner} second recording`);
    await toolPage(page, 'Control');
    await page.getByRole('combobox', { name: 'Browser action', exact: true }).selectOption('evaluate');
    await page.getByRole('textbox', { name: 'Action value', exact: true }).fill('new Promise(() => {})');
    const pendingAction = page.waitForResponse((response) => response.url().endsWith('/execution/browser') && response.request().method() === 'POST' && response.request().postDataJSON()?.method === 'action');
    await page.getByRole('button', { name: 'Run browser action', exact: true }).click();
    await page.getByText('Browser operation in progress…', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close browser', exact: true }).click();
    assert.equal((await pendingAction).status(), 503, 'closing cancels the pending browser operation');
    await page.getByText('No live browser sessions on this station. Open a browser to begin.', { exact: true }).waitFor();
    assert.equal((await browserRpc({ method: 'recording', id: activeTrace.id })).status, 'stopped', 'browser close stops automatic recording');
    await toolPage(page, 'Recordings');
    assert.equal(await page.getByRole('button', { name: 'Start recording', exact: true }).count(), 0, 'collection only offers playback; capture belongs to a session');
    await selectOption(page, 'Recording selector', trace.id);
    const recordedImage = page.getByRole('img', { name: 'Recorded browser frame', exact: true });
    await until(() => recordedImage.evaluate((element) => element.complete && element.naturalWidth > 0), `${owner} recording frame displayed after close`);
    const scrubber = page.getByRole('slider', { name: 'Recording frame', exact: true });
    await scrubber.fill('0');
    await until(async () => (await recordedImage.getAttribute('src')) === `data:image/png;base64,${initialFrame.base64}`, `${owner} scrub first frame`);
    await page.getByRole('button', { name: 'Play recording', exact: true }).click();
    await until(async () => (await recordedImage.getAttribute('src')) === `data:image/png;base64,${laterFrame.base64}`, `${owner} playback advances`, 15_000);
    const pause = page.getByRole('button', { name: 'Pause recording', exact: true });
    if (await pause.isVisible()) await pause.click();
    await page.screenshot({ path: join(artifacts, `${owner}-recording-playback.png`), fullPage: true, animations: 'disabled' });
    // Disk-backed recordings survive replacement of their owning worker, while live sessions do not.
    await stop(services.get(owner), true);
    services.delete(owner);
    await startWorker(owner, browserWorkers.get(owner).primitive, { port: browserWorkers.get(owner).port });
    const recordingUrl = page.url();
    await page.reload();
    assert.equal(page.url(), recordingUrl, 'recording collection deep link survives refresh');
    await selectOption(page, 'Recording selector', trace.id);
    await until(async () => (await page.getByRole('img', { name: 'Recorded browser frame', exact: true }).getAttribute('src')) === `data:image/png;base64,${initialFrame.base64}`, `${owner} durable recording UI after worker restart`);
    assert.equal((await browserRpc({ method: 'recordingFrame', id: trace.id, frameId: trace.frames[0].id })).base64, initialFrame.base64);
    await page.screenshot({ path: join(artifacts, `${owner}-durable-recording.png`), fullPage: true, animations: 'disabled' });
    if (owner === 'playwright-worker') {
      await toolPage(page, 'Profiles');
      await selectOption(page, 'Saved browser profile', 'dashboard-profile');
      await page.getByRole('button', { name: 'Open browser with profile', exact: true }).click();
      await resourceId(page, 'browser');
      await browserAction(page, 'navigate', fixtureUrl);
      await browserAction(page, 'evaluate', "localStorage.getItem('station-profile-test')", /PERSISTED_PROFILE_OK/);
      await page.getByRole('button', { name: 'Close browser', exact: true }).click();
      await page.getByText('No live browser sessions on this station. Open a browser to begin.', { exact: true }).waitFor();
      await toolPage(page, 'Profiles');
      await selectOption(page, 'Saved browser profile', 'dashboard-profile');
      await page.getByRole('button', { name: 'Delete profile', exact: true }).click();
      await until(async () => (await browserRpc({ method: 'profiles' })).length === 0, 'persistent browser profile deletion');
      await toolPage(page, 'Recordings');
      await selectOption(page, 'Recording selector', trace.id);
      record('Playwright localStorage profile survives browser close and worker restart, then deletes through UI');
    }
    record(`${owner} durable recording bytes and dashboard playback survive worker process restart`);
    await page.getByRole('button', { name: 'Delete recording', exact: true }).click();
    await until(async () => !(await browserRpc({ method: 'recordings' })).some((entry) => entry.id === trace.id), `${owner} recording deletion`);
    await selectOption(page, 'Recording selector', activeTrace.id);
    await page.getByRole('button', { name: 'Delete recording', exact: true }).click();
    await until(async () => (await browserRpc({ method: 'recordings' })).length === 0, `${owner} all recording frames deleted`);
    record(`${owner} UI actions, screenshots, five-second recording away from dashboard, playback after close and trace deletion passed`);
  }
  await page.goto(`${base}/settings`);
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await page.getByPlaceholder('e.g. Production App', { exact: true }).fill('dashboard-execution-only');
  await page.getByRole('button', { name: 'execution', exact: true }).click();
  const creatingKey = page.waitForResponse(response => response.url().endsWith('/api/v1/keys') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const keyResponse = await creatingKey;
  assert.equal(keyResponse.status(), 201);
  const executionKey = (await keyResponse.json()).data;
  assert.deepEqual(executionKey.scopes, ['execution'], 'execution scope clears the default operator scopes');
  const keyRow = page.getByRole('row').filter({ hasText: 'dashboard-execution-only' });
  await keyRow.getByText(`Key ID: ${executionKey.id}`, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'settings-execution-key.png'), fullPage: true, animations: 'disabled' });
  const keyContext = await browser.newContext();
  try {
    assert.equal((await keyContext.request.get(`${base}/api/v1/keys`, { headers: { authorization: `Bearer ${executionKey.key}` } })).status(), 403, 'execution-only key cannot list operator keys');
    await keyRow.getByRole('button', { name: 'Revoke', exact: true }).click();
    const revokingKey = page.waitForResponse(response => response.url().endsWith(`/api/v1/keys/${executionKey.id}`) && response.request().method() === 'DELETE');
    await keyRow.getByRole('button', { name: 'Confirm', exact: true }).click();
    assert.equal((await revokingKey).status(), 200);
    assert.equal((await keyContext.request.get(`${base}/api/v1/keys`, { headers: { authorization: `Bearer ${executionKey.key}` } })).status(), 401, 'revoked key is rejected');
  } finally { await keyContext.close(); }
  record('Settings creates execution-only key, displays mapping ID, denies operator access and revokes key');
  assert.deepEqual(pageErrors, [], `Unexpected dashboard JavaScript errors: ${pageErrors.join('; ')}`);
  failed = false;
});
