import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PlaywrightBrowserAdapter } from '../src/playwright.js';

test('real Chromium denies file navigation/new tabs, redirects and scripted local-file access', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'station-browser-navigation-'));
  const file = join(root, 'secret.txt'); writeFileSync(file, 'station-private-file-sentinel');
  const fileUrl = pathToFileURL(file).href;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: fileUrl }); res.end(); }
    else { res.setHeader('content-type', 'text/html'); res.end('<h1>Safe web page</h1><a id="local" href="'+fileUrl+'">Local file</a>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const original = process.env.STATION_BROWSER_TEST_SECRET;
  process.env.STATION_BROWSER_TEST_SECRET = 'worker-only-sentinel';
  const wrapper = join(root, 'chromium'); const observed = join(root, 'environment-check');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s' "\${STATION_BROWSER_TEST_SECRET-absent}" > ${quote(observed)}\nexec ${quote(process.env.STATION_TEST_CHROMIUM ?? chromium.executablePath())} "$@"\n`, { mode: 0o700 });
  const adapter = new PlaywrightBrowserAdapter({ executablePath: wrapper });
  const session = await adapter.open();
  assert.equal(readFileSync(observed, 'utf8') === 'absent', true, 'Browser must not inherit worker credentials');
  try {
    await session.navigate(origin);
    assert.equal(await session.evaluate('document.querySelector("h1").textContent'), 'Safe web page');
    await assert.rejects(session.navigate(fileUrl), /HTTP/);
    await assert.rejects(session.execute!({ op: 'newPage', url: fileUrl }), /HTTP/);
    await assert.rejects(session.navigate(origin + '/redirect'));
    await new Promise(resolve => setTimeout(resolve, 100));
    await session.navigate(origin);
    await session.evaluate(`location.href=${JSON.stringify(fileUrl)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(!String(await session.evaluate('document.body.textContent')).includes('station-private-file-sentinel'));
    await session.click('#local');
    assert.ok(!String(await session.evaluate('document.body.textContent')).includes('station-private-file-sentinel'));
    await session.navigate('about:blank');
  } finally { if (original === undefined) delete process.env.STATION_BROWSER_TEST_SECRET; else process.env.STATION_BROWSER_TEST_SECRET = original; await session.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
