import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, message, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await read()) return; await delay(100); }
  throw new Error(`Timed out: ${message}`);
}
// Uses a separate ephemeral session so the caller's profile/pages remain intact.
export async function browserGapFlow({ page, base, owner, sessionId: callerSession, fixtureUrl, rpc, artifacts, record = () => {} }) {
  let id;
  let resumed;
  const route = view => `${base}/browser-use/${encodeURIComponent(owner)}/sessions/${encodeURIComponent(id)}/${view}`;
  const mutation = async (name, method, op) => {
    const response = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().method() === 'POST' && response.request().postDataJSON()?.method === method && (!op || response.request().postDataJSON()?.command?.op === op));
    await page.getByRole('button', { name, exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    return (await result.json()).data;
  };
  const shot = async name => { if (artifacts) await page.screenshot({ path: join(artifacts, name), fullPage: true, animations: 'disabled' }); };
  try {
    id = (await rpc({ method: 'open' })).id;
    await rpc({ method: 'action', id, action: 'navigate', value: fixtureUrl });
    const boxes = await rpc({ method: 'action', id, action: 'evaluate', value: "['#entry','#apply'].map(s=>{const b=document.querySelector(s).getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})" });
    await page.goto(route('live'));
    const image = page.getByRole('img', { name: 'Live browser screenshot', exact: true });
    await until(async () => await image.count() && await image.evaluate(node => node.complete && node.naturalWidth > 0), 'live screenshot displayed');
    const initialImage = await image.getAttribute('src');
    assert.match(initialImage, /^data:image\/png;base64,iVBOR/);
    assert.equal(await page.getByRole('button', { name: 'Click live browser', exact: true }).isDisabled(), true, 'preview is read-only before takeover');
    await mutation('Take control', 'controlAcquire');
    await until(async () => (await page.getByLabel('Browser control status', { exact: true }).textContent()).includes('You have control'), 'explicit human takeover');
    const initialControl = await rpc({ method: 'control', id });
    const blocked = await page.context().request.post(`${base}/api/v1/stations/${owner}/execution/browser`, { data: { method: 'action', id, action: 'evaluate', value: '1' } });
    assert.equal(blocked.status(), 409, 'automation cannot race human control');
    assert.equal(await page.getByRole('button', { name: 'Close browser', exact: true }).isDisabled(), true, 'close requires releasing control');
    const clickPoint = async box => {
      const bounds = await image.boundingBox();
      const dimensions = await image.evaluate(node => ({ width: node.naturalWidth, height: node.naturalHeight }));
      const result = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.command?.op === 'mouseClick');
      await page.getByRole('button', { name: 'Click live browser', exact: true }).click({ position: { x: box.x * bounds.width / dimensions.width, y: box.y * bounds.height / dimensions.height } });
      assert.equal((await result).status(), 200);
    };
    await clickPoint(boxes[0]);
    await page.getByRole('textbox', { name: 'Live browser text', exact: true }).fill('HUMAN_CONTROL_OK');
    await mutation('Send text', 'action');
    await clickPoint(boxes[1]);
    await until(async () => (await image.getAttribute('src')) !== initialImage, 'live frame reflects human input');
    await until(async () => Date.parse((await rpc({ method: 'control', id })).expiresAt) > Date.parse(initialControl.expiresAt), 'UI renews human control lease', 15_000);
    await shot('browser-live-human-control.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('browser-live-human-control-mobile.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mutation('Release control', 'controlRelease');
    assert.equal(await rpc({ method: 'action', id, action: 'evaluate', value: "document.querySelector('#result').textContent" }), 'HUMAN_CONTROL_OK');
    await mutation('Take control', 'controlAcquire');
    await page.goto(route('inspect'));
    await until(async () => (await rpc({ method: 'control', id })).mode === 'automation', 'navigation releases human lease');
    await mutation('Inspect elements', 'execute', 'inspect');
    await until(async () => (await page.getByLabel('Inspected browser elements', { exact: true }).innerText()).includes('Browser fixture'), 'structured inspection rendered');
    await mutation('Accessibility snapshot', 'execute', 'accessibility');
    await until(async () => (await page.getByLabel('Browser accessibility snapshot', { exact: true }).innerText()).includes('Browser fixture'), 'accessibility snapshot rendered');
    await shot('browser-inspection.png');
    await page.goto(route('diagnostics'));
    await until(() => page.getByLabel('Capture browser console text', { exact: true }).isEnabled(), 'diagnostics ready');
    const consoleResponse = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.command?.consoleText === true);
    await page.getByLabel('Capture browser console text', { exact: true }).check();
    assert.equal((await consoleResponse).status(), 200);
    await mutation('Start trace', 'execute', 'traceStart');
    await until(async () => (await page.getByLabel('Browser trace status', { exact: true }).textContent()) === 'recording', 'trace recording');
    await rpc({ method: 'action', id, action: 'evaluate', value: "console.log('BROWSER_DIAGNOSTIC_OK')" });
    await mutation('Refresh diagnostics', 'audit');
    await until(async () => (await page.getByLabel('Browser diagnostic events', { exact: true }).innerText()).includes('BROWSER_DIAGNOSTIC_OK'), 'opt-in console text displayed');
    await mutation('Stop trace', 'execute', 'traceStop');
    await mutation('Retrieve trace', 'execute', 'downloadRead');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download trace', exact: true }).click();
    const download = await downloadEvent;
    const path = artifacts ? join(artifacts, 'browser-diagnostic-trace.zip') : await download.path();
    if (artifacts) await download.saveAs(path);
    assert.deepEqual([...readFileSync(path).subarray(0, 2)], [80, 75], 'trace download is a ZIP');
    await shot('browser-diagnostics.png');
    await mutation('Delete trace', 'execute', 'downloadDelete');
    await page.goto(route('recovery'));
    const checkpoint = await mutation('Save browser checkpoint', 'checkpoint');
    const checkpointRow = page.getByLabel('Browser checkpoints', { exact: true }).locator('.execution-resource').filter({ hasText: checkpoint.id });
    await checkpointRow.waitFor();
    await shot('browser-recovery.png');
    await rpc({ method: 'close', id });
    await page.goto(`${base}/browser-use/${owner}/recovery`);
    const row = page.getByLabel('Browser checkpoints', { exact: true }).locator('.execution-resource').filter({ hasText: checkpoint.id });
    const restoring = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.method === 'checkpointResume');
    await row.getByRole('button', { name: 'Restore checkpoint', exact: true }).click();
    const restoredResponse = await restoring;
    assert.equal(restoredResponse.status(), 200, await restoredResponse.text());
    resumed = (await restoredResponse.json()).data.id;
    await page.waitForURL(`**/sessions/${resumed}/control`);
    assert.equal(await rpc({ method: 'action', id: resumed, action: 'evaluate', value: 'document.title' }), 'Station browser E2E');
    await rpc({ method: 'close', id: resumed }); resumed = undefined;
    await page.goto(`${base}/browser-use/${owner}/recovery`);
    const deleting = page.waitForResponse(response => response.url().endsWith('/execution/browser') && response.request().postDataJSON()?.method === 'checkpointDelete');
    await page.getByLabel('Browser checkpoints', { exact: true }).locator('.execution-resource').filter({ hasText: checkpoint.id }).getByRole('button', { name: 'Delete checkpoint', exact: true }).click();
    assert.equal((await deleting).status(), 200);
    record('Live screenshots, fenced and renewed human takeover, structured inspection, console/trace diagnostics and explicit checkpoint restore passed');
  } finally {
    // Leaving Live releases any held lease; test-owned sessions are independently closed.
    await page.goto(`${base}/browser-use/${owner}/sessions/${callerSession}/control`);
    for (const owned of [id, resumed].filter(Boolean)) { try { await rpc({ method: 'close', id: owned }); } catch {} }
  }
}
