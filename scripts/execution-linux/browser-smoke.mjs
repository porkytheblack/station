import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { BunBrowserAdapter } from "../../packages/station-browser-use/dist/bun.js";
import { PlaywrightBrowserAdapter } from "../../packages/station-browser-use/dist/playwright.js";

const executablePath = process.env.STATION_TEST_CHROMIUM;
assert.ok(executablePath, "STATION_TEST_CHROMIUM must point to the installed Linux Chromium wrapper");
assert.equal(process.platform, "linux", "This harness validates the Linux target only");

for (const adapter of [
  new BunBrowserAdapter({ bunPath: "bun", chromePath: executablePath, backend: "chrome" }),
  new PlaywrightBrowserAdapter({ executablePath }),
]) {
  test(`${adapter.name}: Linux compiled adapter, input, PNG, independent sessions and cancellation`, { timeout: 90_000 }, async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><html><head><title>Linux Station</title></head><body>
        <input id="name"><button id="go" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Submit</button>
        <p id="result"></p></body></html>`);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const sessions = [];
    try {
      const first = await adapter.open(); sessions.push(first);
      const second = await adapter.open(); sessions.push(second);
      await Promise.all(sessions.map((session) => session.navigate(url)));
      assert.equal(await first.evaluate("document.title"), "Linux Station");
      await first.click("#name");
      await first.type("native Linux!");
      await first.press("Backspace");
      await first.click("#go");
      assert.equal(await first.evaluate("document.querySelector('#result').textContent"), "native Linux");
      await first.evaluate("document.cookie = 'owner=first; path=/'");
      assert.equal(await second.evaluate("document.cookie"), "");
      await second.evaluate("document.cookie = 'owner=second; path=/'");
      assert.equal(await first.evaluate("document.cookie"), "owner=first");
      const png = await first.screenshot();
      assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.ok(png.length > 100);
      const pending = first.evaluate("new Promise(() => {})");
      const rejected = assert.rejects(pending, { code: "browser_closed" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await first.close();
      await rejected;
      await first.close();
      await assert.rejects(first.evaluate("1"), { code: "browser_closed" });
      assert.equal(await second.evaluate("1 + 1"), 2);
      console.log(`${adapter.name}: captured ${png.length} PNG bytes on Linux`);
    } finally {
      const closed = await Promise.allSettled(sessions.map((session) => session.close()));
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const result of closed) if (result.status === "rejected") throw result.reason;
    }
  });
}
