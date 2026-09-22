import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionManager } from "../src/manager.js";
import type { BrowserAdapter, BrowserSession } from "../src/browser.js";
import { managedSession } from "../src/session.js";
import { BunBrowserAdapter } from "../src/bun.js";
import { PlaywrightBrowserAdapter } from "../src/playwright.js";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return { navigate: async () => {}, click: async () => {}, type: async () => {}, press: async () => {}, evaluate: async () => 42, screenshot: async () => Uint8Array.of(137, 80, 78, 71), close: async () => {}, ...overrides };
}
const adapter = (open: () => Promise<BrowserSession>): BrowserAdapter => ({ name: "fixture", capabilities: { screenshots: true, independentSessions: true }, open });

test("opening reservations enforce capacity and shutdown waits for late opens", async () => {
  const opening = deferred<BrowserSession>();
  let closed = false;
  const manager = new BrowserSessionManager(adapter(() => opening.promise), 1);
  const pending = manager.open();
  const rejected = assert.rejects(pending, { code: "unavailable" });
  await assert.rejects(manager.open(), { code: "capacity" });
  let done = false;
  const shutdown = manager.close().then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  opening.resolve(fixture({ close: async () => { closed = true; } }));
  await Promise.all([rejected, shutdown]);
  assert.equal(closed, true);
  assert.deepEqual(manager.list(), []);
  await assert.rejects(manager.open(), { code: "unavailable" });
});

test("operations reject concurrent access and validate byte limits", async () => {
  const evaluated = deferred<unknown>();
  const manager = new BrowserSessionManager(adapter(async () => fixture({ evaluate: () => evaluated.promise })));
  const { id } = await manager.open();
  const running = manager.perform(id, "evaluate", "1");
  await assert.rejects(manager.perform(id, "screenshot"), { code: "busy" });
  evaluated.resolve(3);
  assert.equal(await running, 3);
  await assert.rejects(manager.perform(id, "type", "🙂".repeat(20_000)), { code: "invalid_input" });
  assert.deepEqual(await manager.perform(id, "screenshot"), { mimeType: "image/png", base64: "iVBORw==" });
  await manager.close();
  await assert.rejects(manager.perform(id, "screenshot"), { code: "not_found" });
});

test("closing retains capacity until resources are released", async () => {
  const release = deferred<void>();
  const manager = new BrowserSessionManager(adapter(async () => fixture({ close: () => release.promise })), 1);
  const { id } = await manager.open();
  const close = manager.closeSession(id);
  await assert.rejects(manager.open(), { code: "capacity" });
  const shutdown = manager.close();
  release.resolve();
  await Promise.all([close, shutdown]);
});

test("shutdown attempts every session even if one close fails", async () => {
  let count = 0;
  const manager = new BrowserSessionManager(adapter(async () => fixture({ close: async () => { count++; throw new Error("close failed"); } })));
  await manager.open(); await manager.open();
  await assert.rejects(manager.close(), AggregateError);
  assert.equal(count, 2);
});

test("managed sessions serialize operations and close cancels active and queued work", async () => {
  const started = deferred<void>();
  let closed = 0;
  const browser = managedSession(fixture({ evaluate: async () => { started.resolve(); return new Promise(() => {}); }, close: async () => { closed++; } }), 1000);
  const first = browser.evaluate("1");
  const second = browser.evaluate("2");
  const rejections = [assert.rejects(first, { code: "browser_closed" }), assert.rejects(second, { code: "browser_closed" })];
  await started.promise;
  await Promise.all([browser.close(), browser.close()]);
  await Promise.all(rejections);
  assert.equal(closed, 1);
});

test("timeouts retire sessions rather than leave background work running", async () => {
  let closed = false;
  const browser = managedSession(fixture({ evaluate: async () => new Promise(() => {}), close: async () => { closed = true; } }), 20);
  await assert.rejects(browser.evaluate("1"), { code: "browser_timeout" });
  await browser.close();
  assert.equal(closed, true);
  await assert.rejects(browser.screenshot(), { code: "browser_closed" });
});

test("managed sessions limit queued operations and normalize JSON results", async () => {
  const started = deferred<unknown>();
  const browser = managedSession(fixture({ evaluate: () => started.promise }), 1000);
  const operations = Array.from({ length: 64 }, () => browser.evaluate("1"));
  await assert.rejects(browser.evaluate("overflow"), { code: "busy" });
  started.resolve(undefined);
  assert.deepEqual(await Promise.all(operations), Array(64).fill(null));
  await browser.close();
});

test("invalid configuration and missing Bun fail without hanging", async () => {
  assert.throws(() => new BrowserSessionManager(adapter(async () => fixture()), 0), { code: "invalid_input" });
  await assert.rejects(new BunBrowserAdapter({ width: 0 }).open(), { code: "invalid_input" });
  assert.throws(() => new PlaywrightBrowserAdapter({ timeoutMs: 0 }), { code: "invalid_input" });
  await assert.rejects(new BunBrowserAdapter({ bunPath: "/nonexistent/station-test-bun" }).open(), { code: "ENOENT" });
});

test("action failures release busy state and failed opens release reservations", async () => {
  let attempts = 0;
  const manager = new BrowserSessionManager(adapter(async () => {
    if (++attempts === 1) throw new Error("launch failed");
    return fixture({ click: async () => { throw new Error("missing element"); } });
  }), 1);
  await assert.rejects(manager.open(), /launch failed/);
  const { id } = await manager.open();
  await assert.rejects(manager.perform(id, "click", "#missing"), /missing element/);
  assert.equal(await manager.perform(id, "evaluate", "42"), 42);
  await manager.close();
});

test("response limits reject oversized screenshots and JSON results", async () => {
  const browser = managedSession(fixture({
    screenshot: async () => new Uint8Array(24 * 1024 * 1024 + 1),
    evaluate: async () => "x".repeat(32 * 1024 * 1024),
  }), 1000);
  await assert.rejects(browser.screenshot(), { code: "output_limit" });
  await assert.rejects(browser.evaluate("large"), { code: "output_limit" });
  await browser.close();
});
