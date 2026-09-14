import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStation } from '../../src/server/index.ts';
import { resolveConfig } from '../../src/config/schema.ts';
import { KeyStore, MemoryKeyStorage } from '../../src/server/auth/keys.ts';
import { StationNetworkMemoryAdapter } from 'station-network';
import { BrowserSessionManager } from 'station-browser-use';
import { PlaywrightBrowserAdapter } from 'station-browser-use/playwright';
import { BrowserUseClient, createBrowserAgentTools } from 'station-browser-use/agent';
import { createFoundryBrowserBridge } from '../../../../examples/19-foundry-browser/browser-bridge.mjs';

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function freePort() { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }

test('agent toolset and image bridge use authenticated Headquarters and a real Playwright worker', { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'station-agent-tools-e2e-'));
  const network = new StationNetworkMemoryAdapter();
  const token = randomBytes(32).toString('hex');
  const storage = new MemoryKeyStorage();
  const key = await new KeyStore(storage).create('agent-protocol-fixture', ['admin']);
  const manager = new BrowserSessionManager(new PlaywrightBrowserAdapter(), 1);
  const stations = [];
  let tools;
  const fixture = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<h1>Browser agent protocol fixture</h1><label>Full name<input id="name"></label><button onclick="document.querySelector(\'#done\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><p id="done"></p>'); });
  t.after(async () => { try { await tools?.close(); } finally { for (const station of stations.reverse()) await station.stop(); await manager.close(); await new Promise(resolve => fixture.close(resolve)); rmSync(root, { recursive: true, force: true }); } });
  const fixturePort = await listen(fixture);
  const workerPort = await freePort();
  const worker = await createStation(resolveConfig({ role: 'station', name: 'browser-tools', host: '127.0.0.1', port: workerPort, open: false, runRunners: false, network: { id: 'browser-agent', stationId: 'browser', adapter: network, endpoint: `http://127.0.0.1:${workerPort}` }, execution: { token, browser: manager } }), join(root, 'worker'));
  stations.push(worker); await worker.start();
  const hqPort = await freePort();
  const hq = await createStation(resolveConfig({ role: 'headquarters', host: '127.0.0.1', port: hqPort, open: false, runRunners: false, network: { id: 'browser-agent', stationId: 'hq', adapter: network }, auth: { username: 'operator', password: randomBytes(20).toString('hex'), keyStorage: storage }, execution: { token } }), join(root, 'hq'));
  stations.push(hq); await hq.start();
  const connection = { baseUrl: `http://127.0.0.1:${hqPort}`, stationId: 'browser', access: 'operator' };
  const bad = new BrowserUseClient({ ...connection, apiKey: 'invalid-test-credential' });
  await assert.rejects(bad.request({ method: 'list' }), error => error.status === 401);
  tools = createBrowserAgentTools({ client: new BrowserUseClient({ ...connection, apiKey: key.key }), maxSessions: 1, allowedCommands: ['fill', 'click', 'inspect', 'accessibility'] });
  const call = async (name, input) => { const result = await tools.find(tool => tool.name === `station_browser_${name}`).execute(input); assert.equal(result.status, 'success', result.error?.message); return result; };
  const opened = await call('open', {}); const sessionId = opened.data.id;
  await call('navigate', { sessionId, url: `http://127.0.0.1:${fixturePort}/` });
  assert.match(JSON.stringify((await call('observe', { sessionId })).data), /Full name/);
  await call('interact', { sessionId, command: { op: 'fill', target: { by: 'label', value: 'Full name' }, value: 'Ada Lovelace' } });
  await call('interact', { sessionId, command: { op: 'click', target: { by: 'role', role: 'button', name: 'Save' } } });
  assert.match(JSON.stringify((await call('observe', { sessionId, mode: 'accessibility' })).data), /Saved Ada Lovelace/);
  const lease = manager.acquireControl(sessionId);
  try { const busy = await tools.find(tool => tool.name === 'station_browser_navigate').execute({ sessionId, url: `http://127.0.0.1:${fixturePort}/` }); assert.equal(busy.error.code, 'busy'); }
  finally { manager.releaseControl(sessionId, lease.token); }
  const unowned = await tools.find(tool => tool.name === 'station_browser_close').execute({ sessionId: 'unowned' }); assert.equal(unowned.error.code, 'forbidden');
  let imageRequest;
  const bridge = createFoundryBrowserBridge({ toolset: tools, model: { name: 'protocol-observer-no-inference', setSystemPrompt() {}, async prompt(request) { imageRequest = request; return { messages: [], tokens_in: 0, tokens_out: 0 }; } } });
  const result = await bridge.tools.find(tool => tool.name === 'station_browser_screenshot').do({ sessionId });
  assert.equal(result.status, 'success'); assert.equal('base64' in result.data, false);
  await bridge.model.prompt({ messages: [{ sender: 'user', text: '', tool_results: [{ call_id: 'screen', tool_name: 'station_browser_screenshot', result }] }] }, () => {});
  const image = imageRequest.messages.at(-1).content.find(part => part.type === 'image');
  assert.equal(image.source.media_type, 'image/png'); assert.equal(Buffer.from(image.source.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await call('close', { sessionId }); assert.deepEqual(tools.sessionIds(), []); assert.equal(manager.list().length, 0);
  t.diagnostic('Real HTTP/browser integration; protocol observer performs no model inference and reads no provider credentials.');
});
