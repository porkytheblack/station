import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createStation } from '../packages/station-kit/src/server/index.ts';
import { resolveConfig } from '../packages/station-kit/src/config/schema.ts';
import { KeyStore, MemoryKeyStorage } from '../packages/station-kit/src/server/auth/keys.ts';
import { StationNetworkMemoryAdapter } from '../packages/station-network/dist/index.js';
import { BrowserSessionManager } from '../packages/station-browser-use/dist/manager.js';
import { PlaywrightBrowserAdapter } from '../packages/station-browser-use/dist/playwright.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gloveRoot = process.env.STATION_TEST_GLOVE_ROOT;
const protocolOnly = process.argv.includes('--protocol-only');
if (!gloveRoot || !existsSync(join(gloveRoot, 'packages/glove-foundry/dist/index.js'))) throw new Error('Set STATION_TEST_GLOVE_ROOT to a built local Glove checkout. The test never edits that checkout.');
if (!protocolOnly && !process.env.OPENROUTER_API_KEY && process.env.STATION_TEST_MODEL_ENV_FILE) {
  // Read only the explicitly selected provider key into this process. Never dump env contents.
  const selected = parseEnv(readFileSync(process.env.STATION_TEST_MODEL_ENV_FILE, 'utf8')).OPENROUTER_API_KEY;
  if (selected) process.env.OPENROUTER_API_KEY = selected;
}
if (!protocolOnly && !process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is required for this real-model test; there is no automatic mock or skipped success.');

const root = mkdtempSync(join(tmpdir(), 'station-foundry-agent-'));
const artifacts = join(root, 'artifacts'); mkdirSync(artifacts, { mode: 0o700 });
const project = join(root, 'app'); mkdirSync(project); cpSync(join(repo, 'examples/19-foundry-browser/agents'), join(project, 'agents'), { recursive: true });
cpSync(join(repo, 'examples/19-foundry-browser/browser-bridge.mjs'), join(project, 'browser-bridge.mjs'));
if (protocolOnly) {
  // Explicit local preparation mode. The copied example changes only its model
  // import; public Foundry discovery, assembly, tools and cleanup stay unchanged.
  const agentFile = join(project, 'agents/browser/agent.mjs');
  const source = readFileSync(agentFile, 'utf8');
  const replaced = source.replace("import { createAdapter } from 'glove-core/models/providers';", "import { createAdapter } from '../../protocol-model.mjs';");
  assert.notEqual(replaced, source); writeFileSync(agentFile, replaced);
  writeFileSync(join(project, 'protocol-model.mjs'), `import {writeFileSync} from 'node:fs';import {join} from 'node:path';export function createAdapter(){return {name:'protocol-stub-no-inference',setSystemPrompt(){},async prompt(request){writeFileSync(join(process.env.STATION_BROWSER_ARTIFACT_DIR,'protocol-tools.json'),JSON.stringify(request.tools.map(tool=>({name:tool.name,jsonSchema:typeof tool.jsonSchema==='object'}))),{mode:0o600});return {messages:[{sender:'agent',text:'Foundry protocol mounting validated; no inference performed.'}],tokens_in:0,tokens_out:0};}};}`);
}
writeFileSync(join(project, 'package.json'), JSON.stringify({ type: 'module', private: true }));
mkdirSync(join(project, 'node_modules'));
for (const [name, path] of [['glove-core', join(gloveRoot, 'packages/glove')], ['glove-foundry', join(gloveRoot, 'packages/glove-foundry')], ['station-browser-use', join(repo, 'packages/station-browser-use')]]) symlinkSync(path, join(project, 'node_modules', name), 'dir');
const { FoundryRuntime } = await import(pathToFileURL(join(gloveRoot, 'packages/glove-foundry/dist/index.js')).href);
const verification = `SKY-${randomInt(100, 999)}`;
let submitted;
const fixture = createServer(async (request, response) => {
  if (request.url === '/challenge.svg') {
    response.setHeader('content-type', 'image/svg+xml');
    response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="450" height="100"><rect width="450" height="100" fill="#f0f9ff"/><text x="30" y="67" font-family="sans-serif" font-size="48" fill="#10243a">${verification}</text></svg>`); return;
  }
  if (request.url === '/submit' && request.method === 'POST') {
    let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 4096) { response.writeHead(413).end(); return; } }
    const fields = Object.fromEntries(new URLSearchParams(body));
    if (fields.name !== 'Ada Lovelace' || fields.plan !== 'pro' || fields.code !== verification || fields.agree !== 'yes') { response.writeHead(400).end('Please check the form values.'); return; }
    submitted = fields; response.setHeader('content-type', 'text/html'); response.end('<h1>Registration confirmed</h1><p>Ada Lovelace now has the Pro plan.</p>'); return;
  }
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>Agent registration fixture</title><main style="font:20px sans-serif;padding:32px"><h1>Workspace registration</h1><p>Read the pictured verification code to complete registration.</p><img src="/challenge.svg" alt="Verification code image"><form action="/submit" method="post"><p><label>Full name <input name="name" required></label></p><p><label>Plan <select name="plan"><option value="basic">Basic</option><option value="pro">Pro</option></select></label></p><p><label>Verification code <input name="code" required></label></p><p><label><input type="checkbox" name="agree" value="yes" required> I agree</label></p><button>Register workspace</button></form></main>');
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const freePort = async () => { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
const fixturePort = await listen(fixture);
const network = new StationNetworkMemoryAdapter();
const token = randomBytes(32).toString('hex');
const keyStorage = new MemoryKeyStorage();
const key = await new KeyStore(keyStorage).create('foundry-browser-test', ['admin']);
const manager = new BrowserSessionManager(new PlaywrightBrowserAdapter(), 1, { stateRootDir: join(root, 'browser-state') });
const stations = [];
let runtime, activeRun;
try {
  const workerPort = await freePort();
  const worker = await createStation(resolveConfig({ role: 'station', name: 'foundry-browser', host: '127.0.0.1', port: workerPort, open: false, runRunners: false, network: { id: 'foundry-e2e', stationId: 'browser', adapter: network, endpoint: `http://127.0.0.1:${workerPort}` }, execution: { token, browser: manager } }), join(root, 'worker'));
  stations.push(worker); await worker.start();
  const hqPort = await freePort();
  const hq = await createStation(resolveConfig({ role: 'headquarters', host: '127.0.0.1', port: hqPort, open: false, runRunners: false, network: { id: 'foundry-e2e', stationId: 'hq', adapter: network }, auth: { username: 'operator', password: randomBytes(20).toString('hex'), keyStorage }, execution: { token } }), join(root, 'hq'));
  stations.push(hq); await hq.start();
  Object.assign(process.env, { STATION_URL: `http://127.0.0.1:${hqPort}`, STATION_BROWSER_STATION: 'browser', STATION_API_KEY: key.key, STATION_BROWSER_ACCESS: 'operator', STATION_BROWSER_ARTIFACT_DIR: artifacts });
  runtime = await FoundryRuntime.discover({ rootDir: project, agentsDir: join(project, 'agents'), config: { execution: { pollIntervalMs: 25, idlePollIntervalMs: 25, maxConcurrent: 1, maxAttempts: 1 } } });
  await runtime.start();
  const agent = await runtime.createAgent('browser', { workspaceId: 'browser-e2e' });
  const conversation = await runtime.createConversation(agent.id);
  activeRun = await runtime.send(agent.id, conversation.id, `Open http://127.0.0.1:${fixturePort}/ and register Ada Lovelace on the Pro plan. Inspect the form, take a screenshot, read the verification code from the image, fill all fields, accept I agree, and submit. Verify the confirmation page and close the browser. Do not use JavaScript evaluation or inspect script source. This is a local test form; submission is authorized.`);
  const result = await runtime.waitForRun(activeRun.id, { timeoutMs: 180_000, pollMs: 100 });
  assert.equal(result?.status, 'completed', 'Foundry model run did not complete.');
  const events = readFileSync(join(artifacts, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  let summary;
  if (protocolOnly) {
    const mounted = JSON.parse(readFileSync(join(artifacts, 'protocol-tools.json'), 'utf8'));
    for (const name of ['station_browser_open', 'station_browser_observe', 'station_browser_screenshot', 'station_browser_interact', 'station_browser_close']) assert.ok(mounted.some(tool => tool.name === name && tool.jsonSchema), `Foundry did not mount ${name} with its public JSON schema.`);
    assert.equal(manager.list().length, 0);
    summary = { passed: true, realModel: false, mode: 'Foundry discovery/assembly protocol only', mountedBrowserTools: mounted.filter(tool => tool.name.startsWith('station_browser_')).length, modelCalls: 0 };
  } else {
  assert.ok(submitted, 'The model did not submit the correct form values.');
  assert.ok(events.some(event => event.type === 'model_request' && event.imageParts === 1), 'No actual multimodal image was forwarded to the real model.');
  for (const name of ['station_browser_open', 'station_browser_observe', 'station_browser_screenshot', 'station_browser_interact', 'station_browser_close']) assert.ok(events.some(event => event.type === 'tool' && event.name === name && event.status === 'success'), `Model did not successfully call ${name}.`);
  assert.ok(!events.some(event => event.operation === 'evaluate'));
  assert.equal(manager.list().length, 0, 'Agent cleanup left an active browser.');
  const pngs = readdirSync(artifacts).filter(file => file.endsWith('.png')); assert.ok(pngs.length);
  for (const file of pngs) assert.equal(readFileSync(join(artifacts, file)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  summary = { passed: true, realModel: true, model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4.1-mini', modelCalls: events.filter(event => event.type === 'model_request').length, imageRequests: events.filter(event => event.type === 'model_request' && event.imageParts).length, toolCalls: events.filter(event => event.type === 'tool').length, screenshots: pngs.length, formSubmitted: true, remainingBrowserSessions: manager.list().length };
  }
  writeFileSync(join(artifacts, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, artifacts }));
} finally {
  if (activeRun && runtime) await runtime.cancel(activeRun.id).catch(() => {});
  await runtime?.stop();
  for (const station of stations.reverse()) await station.stop();
  await manager.close();
  await new Promise(resolve => fixture.close(resolve));
  rmSync(project, { recursive: true, force: true });
}
