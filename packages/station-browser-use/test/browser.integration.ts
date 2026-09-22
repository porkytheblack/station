import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { BunBrowserAdapter } from "../dist/bun.js";
import { PlaywrightBrowserAdapter } from "../dist/playwright.js";
import type { BrowserSession } from "../src/browser.js";

for (const backend of [new BunBrowserAdapter(), new PlaywrightBrowserAdapter()]) {
  test(`${backend.name}: real navigation, input, PNG, independent cookies and shutdown`, { timeout: 90_000 }, async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><html><head><title>Station fixture</title></head><body>
      <input id="name"><button id="go" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Submit</button><p id="result"></p>
      </body></html>`);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const sessions: BrowserSession[] = [];
    try {
      const first = await backend.open(); sessions.push(first);
      const second = await backend.open(); sessions.push(second);
      await Promise.all(sessions.map((session) => session.navigate(url)));
      assert.equal(await first.evaluate("document.title"), "Station fixture");
      await first.click("#name");
      await first.type("Station browser");
      await first.press("Backspace");
      await first.click("#go");
      assert.equal(await first.evaluate("document.querySelector('#result').textContent"), "Station browse");
      await first.evaluate("document.cookie = 'session=first; path=/'");
      assert.equal(await second.evaluate("document.cookie"), "");
      await second.evaluate("document.cookie = 'session=second; path=/'");
      assert.equal(await first.evaluate("document.cookie"), "session=first");
      assert.equal(await second.evaluate("document.cookie"), "session=second");
      const screenshot = await first.screenshot();
      assert.deepEqual([...screenshot.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(screenshot.length > 100);
      const pending = first.evaluate("new Promise(() => {})");
      const interrupted = assert.rejects(pending, { code: "browser_closed" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await first.close(); await first.close();
      await interrupted;
      await assert.rejects(first.evaluate("1"), { code: "browser_closed" });
      assert.equal(await second.evaluate("1 + 1"), 2);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}
