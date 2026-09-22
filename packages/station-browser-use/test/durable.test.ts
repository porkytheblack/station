import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { BrowserSessionManager } from "../src/manager.js";
import { validateBrowserCommand, validateBrowserOpenOptions } from "../src/commands.js";
import { BunBrowserAdapter } from "../src/bun.js";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read: () => boolean) { const end = Date.now() + 3000; while (!read()) { if (Date.now() >= end) throw new Error("Timed out"); await sleep(5); } }
const adapter = { name: "test", capabilities: { screenshots: true, independentSessions: true } as const, async open() {
  return { navigate: async () => {}, evaluate: async () => null, click: async () => {}, type: async () => {}, press: async () => {}, screenshot: async () => Uint8Array.of(1, 2, 3, 4), close: async () => {} };
} };

test("durable recordings commit frames, enforce ownership and recover interrupted capture", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-recording-durable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new BrowserSessionManager(adapter, 4, { recordingRootDir: root, maxFrames: 1 });
  assert.throws(() => new BrowserSessionManager(adapter, 4, { recordingRootDir: root }), { code: "busy" });
  const session = await first.open(); const recording = first.startRecording(session.id);
  await until(() => first.getRecording(recording.id).status === "limit");
  const frame = first.getRecording(recording.id).frames[0];
  await first.close();
  const path = join(root, recording.id, "recording.json");
  const metadata = JSON.parse(readFileSync(path, "utf8"));
  metadata.status = "recording"; delete metadata.stoppedAt;
  writeFileSync(path, JSON.stringify(metadata));
  writeFileSync(join(root, recording.id, "orphan.png"), "orphan");
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  writeFileSync(join(root, ".station-owner.json"), JSON.stringify({ pid: dead.pid, hostname: hostname(), token: "old" }));
  const recovered = new BrowserSessionManager(adapter, 4, { recordingRootDir: root });
  try {
    assert.equal(recovered.getRecording(recording.id).status, "stopped");
    assert.equal(recovered.getRecording(recording.id).recovered, true);
    assert.equal(recovered.recordingFrame(recording.id, frame.id).base64, "AQIDBA==");
    assert.ok(!readdirSync(join(root, recording.id)).includes("orphan.png"));
    await recovered.deleteRecording(recording.id);
    assert.deepEqual(recovered.listRecordings(), []);
  } finally { await recovered.close(); }
});

test("durable recovery applies configured byte retention and expired-record cleanup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-recording-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new BrowserSessionManager(adapter, 4, { recordingRootDir: root, maxFrames: 1 });
  const session = await first.open();
  const a = first.startRecording(session.id); await until(() => first.getRecording(a.id).status === "limit");
  const b = first.startRecording(session.id); await until(() => first.getRecording(b.id).status === "limit");
  await first.close();
  const reduced = new BrowserSessionManager(adapter, 4, { recordingRootDir: root, maxTotalBytes: 4 });
  assert.equal(reduced.listRecordings().length, 1);
  await reduced.close(); await sleep(150);
  const expired = new BrowserSessionManager(adapter, 4, { recordingRootDir: root, recordingTtlMs: 100 });
  assert.deepEqual(expired.listRecordings(), []);
  await expired.close();
});

test("recovery rejects frame links and releases its root lock on failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-recording-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new BrowserSessionManager(adapter, 4, { recordingRootDir: root, maxFrames: 1 });
  const session = await first.open(); const recording = first.startRecording(session.id);
  await until(() => first.getRecording(recording.id).status === "limit");
  const frame = first.getRecording(recording.id).frames[0]; await first.close();
  const path = join(root, recording.id, `${frame.id}.png`); rmSync(path); symlinkSync(join(root, recording.id, "recording.json"), path);
  assert.throws(() => new BrowserSessionManager(adapter, 4, { recordingRootDir: root }), { code: "invalid_state" });
  rmSync(path); writeFileSync(path, Uint8Array.of(1, 2, 3, 4));
  const recovered = new BrowserSessionManager(adapter, 4, { recordingRootDir: root }); await recovered.close();
});

test("idle TTL closes sessions and audit metadata omits action values", async () => {
  const manager = new BrowserSessionManager(adapter, 4, { idleTimeoutMs: 100, auditLimit: 3 });
  const session = await manager.open();
  await manager.perform(session.id, "navigate", "https://secret.example/?password=secret");
  await until(() => manager.list().length === 0);
  assert.ok(manager.audit().some((event) => event.event === "idle-expired"));
  assert.equal(JSON.stringify(manager.audit()).includes("secret"), false);
  const events = manager.audit(); events[0].event = "opened";
  assert.equal(manager.audit().length, 3);
  await manager.close();
});

test("structured validators reject traversal, extra fields and oversized file data", async () => {
  assert.throws(() => validateBrowserOpenOptions({ profileId: "../../outside" }), { code: "invalid_input" });
  assert.throws(() => validateBrowserOpenOptions({ proxy: "injected" }), { code: "invalid_input" });
  assert.throws(() => validateBrowserCommand({ op: "fill", selector: "input", value: "a", path: "/tmp/secret" }), { code: "invalid_input" });
  assert.throws(() => validateBrowserCommand({ op: "upload", selector: "input", files: [{ name: "../secret", mimeType: "text/plain", base64: "YQ==" }] }), { code: "invalid_input" });
  assert.throws(() => validateBrowserCommand({ op: "upload", selector: "input", files: [{ name: "big", mimeType: "text/plain", base64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") }] }), { code: "output_limit" });
  await assert.rejects(new BunBrowserAdapter().open({ profileId: "unsupported" }), { code: "unsupported" });
  const manager = new BrowserSessionManager(adapter); const session = await manager.open();
  await assert.rejects(manager.execute(session.id, { op: "pages" }), { code: "unsupported" });
  await manager.close();
});

test("recording/profile roots cannot overlap and recovery preserves unknown files", async (t) => {
  const { PlaywrightBrowserAdapter } = await import("../src/playwright.js");
  const { mkdirSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "station-browser-namespace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new BrowserSessionManager(adapter, 4, { recordingRootDir: root });
  assert.throws(() => new PlaywrightBrowserAdapter({ profileRootDir: root }), { code: "invalid_state" });
  await first.close();
  mkdirSync(join(root, "unknown")); writeFileSync(join(root, "unknown", "valuable"), "keep");
  assert.throws(() => new BrowserSessionManager(adapter, 4, { recordingRootDir: root }), { code: "invalid_state" });
  assert.equal(existsSync(join(root, "unknown", "valuable")), true);
});

test("recording roots retain tenant identity across manager replacement and reject unbound adoption", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "station-recording-tenant-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = new BrowserSessionManager(adapter, 4, { recordingRootDir: root });
  await first.bindTenant("tenant-a");
  await assert.rejects(first.bindTenant("tenant-b"), { code: "invalid_state" });
  await assert.rejects(first.bindTenant(), { code: "invalid_state" });
  const session = await first.open(); const recording = first.startRecording(session.id);
  await until(() => first.getRecording(recording.id).frames.length > 0);
  await first.close();
  const metadataPath = join(root, recording.id, "recording.json");
  const expired = JSON.parse(readFileSync(metadataPath, "utf8")); expired.stoppedAt = "2000-01-01T00:00:00.000Z";
  writeFileSync(metadataPath, JSON.stringify(expired)); const before = readFileSync(metadataPath, "utf8");
  assert.throws(() => new BrowserSessionManager(adapter, 4, { recordingRootDir: root }), { code: "invalid_state" });
  assert.throws(() => new BrowserSessionManager(adapter, 4, { recordingRootDir: root, tenantId: "tenant-b" }), { code: "invalid_state" });
  assert.equal(readFileSync(metadataPath, "utf8"), before, "rejected tenant startup must not recover or prune recording data");
  const second = new BrowserSessionManager(adapter, 4, { recordingRootDir: root, tenantId: "tenant-a" });
  try { await second.bindTenant("tenant-a"); await assert.rejects(second.bindTenant(), { code: "invalid_state" }); }
  finally { await second.close(); }
  const otherRoot = join(root, "unbound");
  const unbound = new BrowserSessionManager(adapter, 4, { recordingRootDir: otherRoot, maxFrames: 1 });
  try {
    const session = await unbound.open(); const recording = unbound.startRecording(session.id);
    await until(() => unbound.getRecording(recording.id).status === "limit");
    await assert.rejects(unbound.bindTenant("tenant-a"), { code: "invalid_state" });
  } finally { await unbound.close(); }
});
