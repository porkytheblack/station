import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { BeaconRunner } from "../src/beacon-runner.js";
import { BeaconMemoryAdapter } from "../src/adapters/memory.js";
import type { BeaconSubscriber } from "../src/subscribers/index.js";
import { readyBeacon } from "./fixtures/ready-beacon.js";
import { crashBeacon } from "./fixtures/crash-beacon.js";
import { quickBeacon } from "./fixtures/quick-beacon.js";
import { stallBeacon } from "./fixtures/stall-beacon.js";
import { manualBeacon } from "./fixtures/manual-beacon.js";

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  type: string;
  name: string;
}

function makeRecorder() {
  const events: Rec[] = [];
  const waiters: Array<{ pred: (all: Rec[]) => boolean; fire: () => void }> = [];

  const push = (type: string, name: string) => {
    events.push({ type, name });
    for (const w of [...waiters]) {
      if (w.pred(events)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.fire();
      }
    }
  };

  const sub: BeaconSubscriber = {
    onBeaconStarting: (e) => push("starting", e.instance.beaconName),
    onBeaconStarted: (e) => push("started", e.instance.beaconName),
    onBeaconReady: (e) => push("ready", e.instance.beaconName),
    onBeaconExited: (e) => push("exited", e.instance.beaconName),
    onBeaconRestartScheduled: (e) => push("restart-scheduled", e.instance.beaconName),
    onBeaconStopped: (e) => push("stopped", e.instance.beaconName),
    onBeaconErrored: (e) => push("errored", e.instance.beaconName),
    onBeaconStalled: (e) => push("stalled", e.instance.beaconName),
  };

  function waitFor(pred: (all: Rec[]) => boolean, label: string, timeoutMs = 12_000): Promise<void> {
    if (pred(events)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.fire === fire);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for ${label}. Seen: ${JSON.stringify(events)}`));
      }, timeoutMs);
      const fire = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push({ pred, fire });
    });
  }

  const count = (type: string, name: string) =>
    events.filter((e) => e.type === type && e.name === name).length;

  return { sub, events, waitFor, count };
}

test("auto-starts a run beacon and reports it ready", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "ready-b"), "ready-b ready");
    const inst = await runner.getInstance("ready-b");
    assert.equal(inst?.status, "running");
    assert.equal(inst?.desiredState, "running");
    assert.ok(inst?.readyAt, "readyAt is recorded");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("restarts a crashing beacon with backoff under on-failure policy", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(crashBeacon, fx("crash-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor(
      (es) => es.filter((e) => e.type === "starting" && e.name === "crash-b").length >= 2,
      "crash-b to restart at least once",
    );
    const inst = await runner.getInstance("crash-b");
    assert.ok((inst?.restartCount ?? 0) >= 1, "restartCount incremented");
    assert.ok(rec.count("restart-scheduled", "crash-b") >= 1, "a restart was scheduled");
    assert.ok(rec.count("exited", "crash-b") >= 1, "the crash was observed as an exit");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("a clean 'never' completion stops without restarting", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(quickBeacon, fx("quick-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor((es) => es.some((e) => e.type === "stopped" && e.name === "quick-b"), "quick-b stopped");
    const inst = await runner.getInstance("quick-b");
    assert.equal(inst?.status, "stopped");
    assert.equal(inst?.desiredState, "stopped", "clean completion parks the beacon");
    await sleep(300);
    assert.equal(rec.count("starting", "quick-b"), 1, "did not restart");
    assert.equal(rec.count("restart-scheduled", "quick-b"), 0);
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("stopBeacon stops a running beacon and keeps it stopped", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "ready-b"), "ready-b ready");
    await runner.stopBeacon("ready-b");
    await rec.waitFor((es) => es.some((e) => e.type === "stopped" && e.name === "ready-b"), "ready-b stopped");
    const inst = await runner.getInstance("ready-b");
    assert.equal(inst?.desiredState, "stopped");
    assert.equal(inst?.status, "stopped");
    await sleep(300);
    assert.equal(rec.count("starting", "ready-b"), 1, "did not relaunch after stop");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("a manualStart beacon stays stopped until startBeacon is called", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(manualBeacon, fx("manual-beacon"));
  runner.start().catch(() => {});
  try {
    await sleep(300);
    let inst = await runner.getInstance("manual-b");
    assert.equal(inst?.desiredState, "stopped");
    assert.equal(rec.count("starting", "manual-b"), 0, "did not auto-start");

    await runner.startBeacon("manual-b");
    await rec.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "manual-b"), "manual-b ready");
    inst = await runner.getInstance("manual-b");
    assert.equal(inst?.status, "running");
    assert.equal(inst?.desiredState, "running");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("restartBeacon relaunches with a fresh incarnation", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "ready-b"), "ready-b ready");
    const before = await runner.getInstance("ready-b");
    assert.equal(before?.incarnation, 1);

    await runner.restartBeacon("ready-b");
    await rec.waitFor(
      (es) => es.filter((e) => e.type === "starting" && e.name === "ready-b").length >= 2,
      "ready-b to relaunch",
    );
    await rec.waitFor(
      (es) => es.filter((e) => e.type === "ready" && e.name === "ready-b").length >= 2,
      "ready-b ready again",
    );
    const after = await runner.getInstance("ready-b");
    assert.ok((after?.incarnation ?? 0) >= 2, "incarnation advanced");
    assert.equal(after?.status, "running");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("detects a heartbeat stall and restarts the beacon", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(stallBeacon, fx("stall-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor((es) => es.some((e) => e.type === "stalled" && e.name === "stall-b"), "stall-b to stall");
    await rec.waitFor(
      (es) => es.filter((e) => e.type === "starting" && e.name === "stall-b").length >= 2,
      "stall-b to restart after stalling",
    );
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});
