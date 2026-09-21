import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { BrowserTrafficPolicy } from "../src/reliability.js";
function fixture(url = "https://example.com/page") {
  let challenge = false; const frame = {};
  const page = Object.assign(new EventEmitter(), { url: () => url, isClosed: () => false, mainFrame: () => frame, evaluate: async () => challenge });
  return { page: page as unknown as Page, challenge: (value: boolean) => { challenge = value; },
    response: (status: number, headers = {}) => page.emit("response", { status: () => status, url: () => url, frame: () => frame, request: () => ({ isNavigationRequest: () => true }), headers: () => headers }) };
}
test("challenge pauses mutations but human takeover remains usable; no action retry", async () => {
  const policy = new BrowserTrafficPolicy({ minIntervalMs: 0 }); const { page, challenge } = fixture(); let mutations = 0;
  challenge(true);
  await assert.rejects(policy.run(page, async () => { mutations++; }, false), { code: "challenge_required" }); assert.equal(mutations, 0);
  await policy.run(page, async () => { challenge(false); mutations++; }, true);
  await policy.run(page, async () => { mutations++; }, false); assert.equal(mutations, 2);
  await assert.rejects(policy.run(page, async () => { mutations++; challenge(true); }, false), { code: "challenge_required" }); assert.equal(mutations, 3);
});
test("origin limits span sessions and allow independent origins", async () => {
  const policy = new BrowserTrafficPolicy({ minIntervalMs: 0, maxConcurrentPerOrigin: 1 }); const first = fixture(), second = fixture(), other = fixture("https://other.example/path");
  let finish!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = policy.run(first.page, () => { started(); return new Promise<void>(resolve => { finish = resolve; }); }, false);
  await entered;
  await assert.rejects(policy.run(second.page, async () => {}, false), { code: "rate_limited" });
  await policy.run(other.page, async () => {}, false); finish(); await pending;
  await policy.run(second.page, async () => {}, false);
});
test("429 backoff is bounded, shared by origin, and does not repeat a request", async () => {
  const policy = new BrowserTrafficPolicy({ minIntervalMs: 0, maxBackoffMs: 1000 }); const first = fixture(), second = fixture(); policy.watch(first.page);
  first.response(429, { "retry-after": "999999" });
  const state = await policy.inspect(second.page); assert.equal(state.status, "throttled"); assert.ok(state.retryAfterMs! <= 1000);
  let calls = 0; await assert.rejects(policy.run(second.page, async () => { calls++; }, false), { code: "rate_limited" }); assert.equal(calls, 0);
});
test("403 is reported without labeling every forbidden page as a CAPTCHA", async () => {
  const policy = new BrowserTrafficPolicy({ minIntervalMs: 0 }); const f = fixture(); policy.watch(f.page); f.response(403);
  assert.deepEqual(await policy.inspect(f.page), { status: "blocked", reason: "http-403" });
  f.response(200); assert.deepEqual(await policy.inspect(f.page), { status: "ready" });
});
