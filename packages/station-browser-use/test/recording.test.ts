import assert from "node:assert/strict";
import test from "node:test";
import { BrowserSessionManager } from "../src/manager.js";
import type { BrowserSession } from "../src/browser.js";
import type { BrowserRecordingOptions } from "../src/recording.js";
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() >= deadline) throw new Error("Condition did not settle"); await sleep(5); }
}
function manager(overrides: Partial<BrowserSession> = {}, options: BrowserRecordingOptions = {}) {
  return new BrowserSessionManager({ name: "fixture", capabilities: { screenshots: true, independentSessions: true }, async open() {
    return { navigate: async () => {}, evaluate: async () => null, click: async () => {}, type: async () => {}, press: async () => {}, screenshot: async () => Uint8Array.of(137, 80, 78, 71), close: async () => {}, ...overrides };
  } }, 4, options);
}

test("records immediately and on worker ticks, then retains frames after session close", async (t) => {
  let captured = 0;
  const browsers = manager({ screenshot: async () => Uint8Array.of(++captured) }, { intervalMs: 100 });
  t.after(() => browsers.close());
  const session = await browsers.open();
  const recording = browsers.startRecording(session.id);
  assert.equal(browsers.startRecording(session.id).id, recording.id, "start is idempotent while active");
  await until(() => browsers.getRecording(recording.id).frames.length >= 2);
  const first = browsers.getRecording(recording.id).frames[0];
  assert.equal(browsers.recordingFrame(recording.id, first.id).base64, "AQ==");
  await browsers.closeSession(session.id);
  const stopped = browsers.getRecording(recording.id);
  assert.equal(stopped.status, "stopped");
  assert.ok(stopped.stoppedAt);
  const count = captured;
  await sleep(150);
  assert.equal(captured, count, "close clears the timer");
  assert.ok(browsers.getRecording(recording.id).frames.length >= 2, "frames survive live session close");
  await browsers.deleteRecording(recording.id);
  assert.deepEqual(browsers.listRecordings(), []);
  assert.throws(() => browsers.getRecording(recording.id), { code: "not_found" });
});

test("busy ticks are skipped without overlapping or queuing captures", async (t) => {
  const action = deferred<unknown>();
  const image = deferred<Uint8Array>();
  let captures = 0;
  const browsers = manager({ evaluate: () => action.promise, screenshot: async () => { captures++; return image.promise; }, close: async () => image.reject(new Error("closed")) }, { intervalMs: 100 });
  t.after(() => browsers.close());
  const { id } = await browsers.open();
  const performing = browsers.perform(id, "evaluate", "pending");
  const recording = browsers.startRecording(id);
  await until(() => browsers.getRecording(recording.id).skipped >= 2);
  assert.equal(captures, 0);
  action.resolve(null); await performing;
  await until(() => captures === 1);
  await sleep(150);
  assert.equal(captures, 1, "a slow screenshot never creates a second capture");
  await assert.rejects(browsers.perform(id, "evaluate", "1"), { code: "busy" });
  let stopped = false;
  const stopping = browsers.stopRecording(recording.id).then(() => { stopped = true; });
  await sleep(10);
  assert.equal(stopped, false, "stop waits for in-flight capture");
  image.resolve(Uint8Array.of(1)); await stopping;
  assert.equal(browsers.getRecording(recording.id).frames.length, 0, "unfinished capture is discarded on stop");
});

test("frame limit stops recording without evicting prior frames", async (t) => {
  const browsers = manager({}, { intervalMs: 100, maxFrames: 2 });
  t.after(() => browsers.close());
  const { id } = await browsers.open();
  const recording = browsers.startRecording(id);
  await until(() => browsers.getRecording(recording.id).status === "limit");
  const result = browsers.getRecording(recording.id);
  assert.equal(result.frames.length, 2);
  assert.equal(result.bytes, 8);
  assert.equal((await browsers.stopRecording(recording.id)).status, "limit");
  await sleep(150);
  assert.deepEqual(browsers.getRecording(recording.id).frames, result.frames);
});

test("global PNG budget is atomic across sessions and deletion restores capacity", async (t) => {
  const browsers = manager({}, { intervalMs: 100, maxTotalBytes: 7, maxRecordings: 2 });
  t.after(() => browsers.close());
  const first = await browsers.open(); const second = await browsers.open();
  const a = browsers.startRecording(first.id); const b = browsers.startRecording(second.id);
  await until(() => browsers.listRecordings().every((recording) => recording.status === "limit"));
  assert.equal(browsers.getRecording(a.id).bytes, 4);
  assert.equal(browsers.getRecording(b.id).bytes, 0);
  assert.equal(browsers.listRecordings().reduce((sum, recording) => sum + recording.bytes, 0), 4);
  assert.throws(() => browsers.startRecording(first.id), { code: "capacity" });
  await Promise.all([browsers.deleteRecording(a.id), browsers.deleteRecording(a.id)]);
  const fresh = browsers.startRecording(first.id);
  await until(() => browsers.getRecording(fresh.id).frames.length === 1);
  assert.equal(browsers.getRecording(fresh.id).bytes, 4);
});

test("metadata and frame reads do not expose mutable storage", async (t) => {
  const image = Uint8Array.of(1, 2, 3);
  const browsers = manager({ screenshot: async () => image }, { maxFrames: 1 });
  t.after(() => browsers.close());
  const { id } = await browsers.open();
  const recording = browsers.startRecording(id);
  assert.equal(recording.intervalMs, 5000);
  recording.frames.push({ id: "fake", capturedAt: "fake", bytes: 9 });
  await until(() => browsers.getRecording(recording.id).status === "limit");
  const metadata = browsers.getRecording(recording.id);
  const frameId = metadata.frames[0].id;
  metadata.frames[0].bytes = 999;
  browsers.listRecordings()[0].frames.length = 0;
  image[0] = 9;
  assert.equal(browsers.getRecording(recording.id).frames[0].bytes, 3);
  const frame = browsers.recordingFrame(recording.id, frameId); frame.base64 = "changed";
  assert.deepEqual(browsers.recordingFrame(recording.id, frameId), { mimeType: "image/png", base64: "AQID" });
  assert.throws(() => browsers.recordingFrame(recording.id, "missing"), { code: "not_found" });
});

test("capture errors stop timers and do not retain backend secrets", async (t) => {
  let captures = 0;
  const browsers = manager({ screenshot: async () => { captures++; throw new Error("secret-worker-credential"); } }, { intervalMs: 100 });
  t.after(() => browsers.close());
  const { id } = await browsers.open();
  const recording = browsers.startRecording(id);
  await until(() => browsers.getRecording(recording.id).status === "error");
  assert.equal(browsers.getRecording(recording.id).error, "Screenshot capture failed.");
  await sleep(150);
  assert.equal(captures, 1);
});

test("session close and shutdown interrupt captures before waiting for them", async () => {
  const image = deferred<Uint8Array>();
  let capturing = false;
  let closed = 0;
  const browsers = manager({ screenshot: async () => { capturing = true; return image.promise; }, close: async () => { closed++; image.reject(new Error("closed")); } }, { intervalMs: 100 });
  const { id } = await browsers.open();
  const recording = browsers.startRecording(id);
  await until(() => capturing);
  await browsers.close();
  assert.equal(closed, 1);
  assert.equal(browsers.getRecording(recording.id).status, "stopped");
  assert.equal(browsers.getRecording(recording.id).error, undefined);
  assert.throws(() => browsers.startRecording(id), { code: "unavailable" });
});

test("delete during an in-flight capture waits and discards the late frame", async (t) => {
  const image = deferred<Uint8Array>();
  let capturing = false;
  const browsers = manager({ screenshot: async () => { capturing = true; return image.promise; } }, { intervalMs: 100 });
  t.after(() => browsers.close());
  const { id } = await browsers.open();
  const recording = browsers.startRecording(id);
  await until(() => capturing);
  const deletion = browsers.deleteRecording(recording.id);
  image.resolve(Uint8Array.of(1, 2));
  await deletion;
  assert.deepEqual(browsers.listRecordings(), []);
});

test("recording configuration has finite bounds and requires a live session", async () => {
  for (const options of [{ intervalMs: 99 }, { maxFrames: 0 }, { maxRecordings: 1025 }, { maxTotalBytes: Infinity }]) {
    assert.throws(() => manager({}, options), { code: "invalid_input" });
  }
  const browsers = manager();
  assert.throws(() => browsers.startRecording("missing"), { code: "not_found" });
  await browsers.close();
});
