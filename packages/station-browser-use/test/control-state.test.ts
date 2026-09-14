import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessionManager } from "../src/manager.js";
import { BrowserUseError, type BrowserAdapter, type BrowserSession } from "../src/browser.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function adapter(overrides: Partial<BrowserSession> = {}): BrowserAdapter {
  return { name: "test", capabilities: { screenshots: true, independentSessions: true, pages: true, commands: true }, async open() {
    return { async navigate() {}, async click() {}, async type() {}, async press() {}, async evaluate() { return "ok"; }, async screenshot() { return Buffer.from("png"); }, async execute(command) { return command.op === "pages" ? [{ id: "page1", url: "https://example.com/path?access_token=secret#private", selected: true, title: "Private title" }] : null; }, async close() {}, ...overrides };
  } };
}

test("exclusive human leases fence automation, expire and reject stale tokens", async () => {
  const manager = new BrowserSessionManager(adapter());
  try {
    const browser = await manager.open();
    const lease = manager.acquireControl(browser.id, 1000);
    assert.equal(manager.control(browser.id).mode, "human");
    assert.throws(() => manager.acquireControl(browser.id), /owner/);
    await assert.rejects(manager.perform(browser.id, "click", "button"), /lease/);
    await assert.rejects(manager.execute(browser.id, { op: "pages" }), /lease/);
    await manager.perform(browser.id, "click", "button", lease.token);
    assert.equal((await manager.liveFrame(browser.id)).mimeType, "image/png");
    assert.throws(() => manager.releaseControl(browser.id, "wrong"), /lost/);
    manager.renewControl(browser.id, lease.token, 1000);
    await delay(1050);
    assert.equal(manager.control(browser.id).mode, "automation");
    await assert.rejects(manager.perform(browser.id, "click", "button", lease.token), /expired/);
    await manager.perform(browser.id, "click", "button");
    assert.ok(!JSON.stringify(manager.audit()).includes(lease.token));
  } finally { await manager.close(); }
});

test("takeover never steals an operation already in progress", async () => {
  let finish!: () => void;
  const manager = new BrowserSessionManager(adapter({ evaluate: () => new Promise(resolve => { finish = () => resolve(null); }) }));
  try {
    const browser = await manager.open();
    const pending = manager.perform(browser.id, "evaluate", "private expression");
    assert.throws(() => manager.acquireControl(browser.id), /active operation/);
    await assert.rejects(manager.liveFrame(browser.id), /progress/);
    finish(); await pending;
    const lease = manager.acquireControl(browser.id);
    manager.releaseControl(browser.id, lease.token);
    assert.equal(manager.control(browser.id).mode, "automation");
  } finally { await manager.close(); }
});

test("live observation does not keep an idle browser alive", async () => {
  const manager = new BrowserSessionManager(adapter(), 4, { idleTimeoutMs: 100 });
  try {
    const browser = await manager.open();
    for (let index = 0; index < 3; index++) { await delay(25); await manager.liveFrame(browser.id); }
    await delay(150);
    assert.equal(manager.list().length, 0);
  } finally { await manager.close(); }
});

test("journal and checkpoints survive restart, redact URL secrets and replay no actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-state-"));
  const first = new BrowserSessionManager(adapter(), 4, { stateRootDir: root, tenantId: "tenant-one" });
  let checkpoint;
  try {
    const browser = await first.open();
    await first.perform(browser.id, "type", "top-secret-password");
    checkpoint = await first.checkpoint(browser.id);
    assert.deepEqual(checkpoint.urls, ["https://example.com/path"]);
    assert.ok(!JSON.stringify(first.audit()).includes("top-secret-password"));
  } finally { await first.close(); }
  const visited: string[] = [];
  const second = new BrowserSessionManager(adapter({ async navigate(url) { visited.push(url); }, async type() { throw Error("Must not replay typing"); } }), 4, { stateRootDir: root, tenantId: "tenant-one" });
  try {
    assert.equal(second.list().length, 0);
    assert.ok(second.audit().some(entry => entry.operation === "type" && entry.phase === "finished"));
    const restored = await second.resumeCheckpoint(checkpoint!.id);
    assert.deepEqual(visited, ["https://example.com/path"]);
    assert.notEqual(restored.id, checkpoint!.sessionId);
    second.deleteCheckpoint(checkpoint!.id);
    assert.deepEqual(second.listCheckpoints(), []);
    const seq = second.audit().map(entry => entry.sequence);
    assert.equal(new Set(seq).size, seq.length);
  } finally { await second.close(); }
  assert.throws(() => new BrowserSessionManager(adapter(), 4, { stateRootDir: root, tenantId: "tenant-two" }), /recovered/);
  rmSync(root, { recursive: true, force: true });
});

test("corrupt or simultaneously owned journals fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-journal-"));
  const manager = new BrowserSessionManager(adapter(), 4, { stateRootDir: root });
  assert.throws(() => new BrowserSessionManager(adapter(), 4, { stateRootDir: root }), /owner/);
  await manager.close();
  writeFileSync(join(root, "state.json"), "broken");
  assert.throws(() => new BrowserSessionManager(adapter(), 4, { stateRootDir: root }), /recovered/);
  rmSync(root, { recursive: true, force: true });
});

test("in-memory managers fence tenant identity independently of adapter persistence", async () => {
  const manager = new BrowserSessionManager(adapter());
  try {
    await manager.bindTenant("tenant-a");
    const browser = await manager.open();
    await assert.rejects(manager.bindTenant("tenant-b"), { code: "invalid_state" });
    await assert.rejects(manager.bindTenant(), { code: "invalid_state" });
    await manager.bindTenant("tenant-a");
    assert.equal(manager.list()[0].id, browser.id);
  } finally { await manager.close(); }
  const existing = new BrowserSessionManager(adapter());
  try { await existing.open(); await assert.rejects(existing.bindTenant("tenant-a"), { code: "invalid_state" }); }
  finally { await existing.close(); }
});

test("tenant binding blocks admission and a failed partial binding stays closed to work", async () => {
  let resolve!: () => void;
  const implementation = adapter();
  implementation.bindTenant = () => new Promise<void>(done => { resolve = done; });
  const manager = new BrowserSessionManager(implementation);
  try {
    const pending = manager.bindTenant("tenant-a");
    await assert.rejects(manager.open(), { code: "busy" });
    await assert.rejects(manager.bindTenant("tenant-b"), { code: "invalid_state" });
    resolve(); await pending;
    await manager.open();
  } finally { await manager.close(); }
  const failure = adapter();
  failure.bindTenant = async () => { throw Error("adapter binding failed"); };
  const failed = new BrowserSessionManager(failure);
  try { await assert.rejects(failed.bindTenant("tenant-a"), /binding failed/); await assert.rejects(failed.open(), { code: "unavailable" }); }
  finally { await failed.close(); }
});


test("a failed write-ahead journal prevents side effects while browser cleanup still runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-audit-failure-"));
  let effects = 0, closed = 0;
  const manager = new BrowserSessionManager(adapter({ async evaluate() { effects++; return null; }, async close() { closed++; } }), 4, { stateRootDir: root });
  try {
    const browser = await manager.open();
    rmSync(join(root, "state.json")); mkdirSync(join(root, "state.json"));
    await assert.rejects(manager.perform(browser.id, "evaluate", "side effect"), { code: "storage_error" });
    assert.equal(effects, 0);
    await assert.rejects(manager.perform(browser.id, "evaluate", "retry"), { code: "unavailable" });
    await assert.rejects(manager.close(), /shutdown failed/);
    assert.equal(closed, 1, "journal failure must not strand a browser process");
    assert.equal(existsSync(join(root, ".station-owner.json")), false, "shutdown releases the journal ownership lock");
  } finally { await manager.close().catch(() => undefined); rmSync(root, { recursive: true, force: true }); }
});


test("shutdown releases the journal even when recording ownership release fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-store-close-"));
  const stateRootDir = join(root, "state"), recordingRootDir = join(root, "recordings");
  let closed = 0;
  const manager = new BrowserSessionManager(adapter({ async close() { closed++; } }), 4, { stateRootDir, recordingRootDir });
  try {
    await manager.open();
    writeFileSync(join(recordingRootDir, ".station-owner.json"), "corrupt ownership metadata");
    await assert.rejects(manager.close());
    assert.equal(closed, 1);
    assert.equal(existsSync(join(stateRootDir, ".station-owner.json")), false);
  } finally { await manager.close().catch(() => undefined); rmSync(root, { recursive: true, force: true }); }
});

test("a failed completion journal records an uncertain action and never replays it", async () => {
  const root = mkdtempSync(join(tmpdir(), "station-browser-audit-completion-"));
  const path = join(root, "state.json"); let effects = 0, persisted = "";
  const manager = new BrowserSessionManager(adapter({ async evaluate() { effects++; persisted = readFileSync(path, "utf8"); rmSync(path); mkdirSync(path); return "already executed"; } }), 4, { stateRootDir: root });
  try {
    const browser = await manager.open();
    await assert.rejects(manager.perform(browser.id, "evaluate", "side effect"), { code: "storage_error" });
    assert.equal(effects, 1);
    await assert.rejects(manager.perform(browser.id, "evaluate", "retry"), { code: "unavailable" });
    assert.deepEqual(manager.audit().filter(entry => entry.operation === "evaluate").map(entry => entry.phase), ["started"]);
    rmSync(path, { recursive: true }); writeFileSync(path, persisted); await manager.close();
    const recovered = new BrowserSessionManager(adapter({ async evaluate() { throw Error("must not replay"); } }), 4, { stateRootDir: root });
    try { assert.equal(recovered.list().length, 0); assert.deepEqual(recovered.audit().filter(entry => entry.operation === "evaluate").map(entry => entry.phase), ["started"]); }
    finally { await recovered.close(); }
  } finally { await manager.close().catch(() => undefined); rmSync(root, { recursive: true, force: true }); }
});


test("shutdown propagates unavailable cleanup errors instead of treating them as cancelled opens", async () => {
  let adapterClosed = false;
  const implementation = adapter({ async close() { throw new BrowserUseError("unavailable", "browser cleanup failed"); } });
  implementation.close = async () => { adapterClosed = true; };
  const manager = new BrowserSessionManager(implementation);
  await manager.open();
  await assert.rejects(manager.close(), (error: unknown) => error instanceof AggregateError && error.errors.some(value => value instanceof BrowserUseError && value.message === "browser cleanup failed"));
  assert.equal(adapterClosed, true);
});

test("only a successfully cleaned opening is ignored when shutdown wins the race", async () => {
  for (const failsCleanup of [false, true]) {
    let finish!: () => void;
    const underlying = await adapter({ async close() { if (failsCleanup) throw new BrowserUseError("unavailable", "opening cleanup failed"); } }).open();
    const implementation = adapter();
    implementation.open = () => new Promise(resolve => { finish = () => resolve(underlying); });
    const manager = new BrowserSessionManager(implementation);
    const opening = manager.open();
    const openingFailure = assert.rejects(opening, { code: "unavailable" });
    const closing = manager.close();
    finish();
    await openingFailure;
    if (failsCleanup) await assert.rejects(closing, /shutdown failed/);
    else await closing;
  }
});
