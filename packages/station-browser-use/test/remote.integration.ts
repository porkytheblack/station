import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { BrowserbaseBrowserAdapter, SteelBrowserAdapter } from "../dist/remote.js";
import { PlaywrightBrowserAdapter } from "../dist/playwright.js";
import { BrowserSessionManager } from "../dist/manager.js";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("both provider adapters: real CDP, agent controls, recording, challenges and human takeover", { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "station-remote-cdp-"));
  const browsers = new Map<string, { endpoint: string; stop(): Promise<void> }>();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/challenge") return response.end('<title>Verify you are human</title><p>Verify you are human</p><button id="continue" onclick="location.href=\'/\'">Continue after human review</button>');
    if (request.url === "/limited") { response.statusCode = 429; response.setHeader("Retry-After", "1"); return response.end("Too many requests"); }
    response.end('<title>Fixture</title><input id="name"><button id="go" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result"></p>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object"); const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await Promise.all([...browsers.values()].map(browser => browser.stop())); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  let creates = 0; let releases = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/sessions")) {
      creates++;
      const id = randomUUID(); const profile = join(root, id);
      const child = spawn(chromium.executablePath(), ["--headless", "--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
      const ended = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
      const stop = async () => { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 2000); try { await ended; } finally { clearTimeout(timer); } };
      const endpoint = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { void stop(); reject(new Error("Chromium CDP startup timed out")); }, 10000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Chromium exited before CDP startup")); });
        let output = ""; child.stderr.on("data", bytes => { output += bytes.toString(); const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      });
      browsers.set(id, { endpoint, stop });
      return Response.json({ id, connectUrl: `wss://connect.browserbase.com?sessionId=${id}` });
    }
    releases++; const id = new URL(String(url)).pathname.split("/")[3];
    await browsers.get(id)?.stop(); browsers.delete(id); return Response.json({});
  };
  class BrowserbaseCDP extends BrowserbaseBrowserAdapter { protected override attach(endpoint: string, artifactsDir: string) { const id = new URL(endpoint).searchParams.get("sessionId")!; return chromium.connectOverCDP(browsers.get(id)!.endpoint, { artifactsDir }); } }
  class SteelCDP extends SteelBrowserAdapter { protected override attach(endpoint: string, artifactsDir: string) { const id = new URL(endpoint).searchParams.get("sessionId")!; return chromium.connectOverCDP(browsers.get(id)!.endpoint, { artifactsDir }); } }
  for (const Adapter of [BrowserbaseCDP, SteelCDP]) {
    const adapter = new Adapter({ rootDir: join(root, Adapter.name), apiKey: "fixture", projectId: "fixture-project", fetch: transport, reliability: { minIntervalMs: 0, maxBackoffMs: 1000 } });
    const manager = new BrowserSessionManager(adapter, 2, { intervalMs: 100, maxFrames: 4 });
    try {
      const session = await manager.open();
      await manager.perform(session.id, "navigate", origin);
      await manager.execute(session.id, { op: "fill", selector: "#name", value: "Remote Station" });
      await manager.execute(session.id, { op: "click", selector: "#go" });
      assert.equal(await manager.perform(session.id, "evaluate", "document.querySelector('#result').textContent"), "Remote Station");
      const recording = manager.startRecording(session.id);
      await pause(500); const stopped = await manager.stopRecording(recording.id);
      assert.ok(stopped.frames.length >= 1);
      const screenshot = await manager.perform(session.id, "screenshot") as { base64: string };
      assert.deepEqual([...Buffer.from(screenshot.base64, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      await assert.rejects(manager.perform(session.id, "navigate", `${origin}/challenge`), { code: "challenge_required" });
      assert.equal((await manager.execute(session.id, { op: "diagnostics" }) as any).reliability.status, "challenge");
      await assert.rejects(manager.execute(session.id, { op: "click", selector: "#continue" }), { code: "challenge_required" });
      assert.ok((await manager.liveFrame(session.id)).base64.length > 100);
      const control = manager.acquireControl(session.id);
      await assert.rejects(manager.perform(session.id, "navigate", origin), { code: "busy" });
      await manager.execute(session.id, { op: "click", selector: "#continue" }, control.token);
      manager.releaseControl(session.id, control.token);
      await manager.execute(session.id, { op: "waitFor", selector: "#name" });
      await assert.rejects(manager.perform(session.id, "navigate", `${origin}/limited`), { code: "rate_limited" });
      const diagnostics = await manager.execute(session.id, { op: "diagnostics" }) as any;
      assert.equal(diagnostics.reliability.status, "throttled");
      await assert.rejects(manager.execute(session.id, { op: "traceStart" }), { code: "unsupported" });
    } finally { await manager.close(); }
  }
  assert.equal(creates, 2); assert.equal(releases, 2); assert.equal(browsers.size, 0);
});

test("local Playwright uses the same opt-in challenge controls", { timeout: 30000 }, async () => {
  const browser = await new PlaywrightBrowserAdapter({ reliability: { minIntervalMs: 0 } }).open();
  try {
    await assert.rejects(browser.navigate("data:text/html,<title>Verify you are human</title><p>Verify you are human</p>"), { code: "challenge_required" });
    assert.ok((await browser.screenshot()).byteLength > 100);
  } finally { await browser.close(); }
});

test("container worker protocol forwards reliability settings and trusted human context", { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [new URL("../dist/container-worker.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>(); let sequence = 0; let buffer = "";
  child.stderr.resume();
  child.stdout.on("data", bytes => {
    buffer += bytes.toString(); let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
      const call = pending.get(message.id); pending.delete(message.id);
      if (message.error) call?.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else call?.resolve(message.result);
    }
  });
  const ended = new Promise<void>(resolve => child.once("exit", () => { for (const call of pending.values()) call.reject(new Error("worker exited")); resolve(); }));
  const rpc = (op: string, value?: unknown, extra = {}) => new Promise<any>((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, op, value, ...extra }) + "\n"); });
  try {
    await rpc("open", undefined, { options: {}, settings: { reliability: { minIntervalMs: 0 }, locale: "en-US", timezoneId: "UTC" } });
    await assert.rejects(rpc("navigate", "data:text/html,<title>Verify you are human</title><p>Verify you are human</p>"), { code: "challenge_required" });
    await assert.rejects(rpc("evaluate", "1+1"), { code: "challenge_required" });
    assert.ok((await rpc("screenshot")).length > 100);
    await rpc("evaluate", "document.title='Ready';document.body.textContent='Ready'", { humanControl: true });
    assert.equal(await rpc("evaluate", "1+1"), 2);
  } finally { await rpc("close").catch(() => undefined); child.stdin.end(); await ended; }
});


test("a missing target times out without closing local or attached browser sessions", { timeout: 20000 }, async () => {
  for (const remote of [false, true]) {
    class AttachedFixture extends PlaywrightBrowserAdapter {
      protected override async connectRemote() {
        const browser = await chromium.launch({ headless: true });
        return { context: await browser.newContext(), close: () => browser.close(), isConnected: () => browser.isConnected() };
      }
    }
    const adapter = remote ? new AttachedFixture({ timeoutMs: 2000 }) : new PlaywrightBrowserAdapter({ timeoutMs: 2000 });
    const session = await adapter.open();
    try {
      await session.navigate("data:text/html,<button id='ok'>Ready</button>");
      await assert.rejects(session.execute!({ op: "click", selector: "#missing" }), /Timeout/);
      assert.equal(await session.evaluate("document.querySelector('#ok').textContent"), "Ready");
      await session.execute!({ op: "click", selector: "#ok" });
    } finally { await session.close(); }
  }
});
