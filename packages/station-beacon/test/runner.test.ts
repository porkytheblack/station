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
import {
  startupTimeoutBeacon,
  startupTimeoutNeverBeacon,
} from "./fixtures/startup-timeout-beacon.js";
import { manualBeacon } from "./fixtures/manual-beacon.js";
import { badConfigBeacon } from "./fixtures/bad-config-beacon.js";
import { workerBeacon } from "./fixtures/worker-beacon.js";

const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rec {
  type: string;
  name: string;
  /** Instance id — equals `name` for a beacon's definition-owned instance. */
  id: string;
}

function makeRecorder() {
  const events: Rec[] = [];
  const waiters: Array<{ pred: (all: Rec[]) => boolean; fire: () => void }> = [];

  const push = (type: string, name: string, id: string) => {
    events.push({ type, name, id });
    for (const w of [...waiters]) {
      if (w.pred(events)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.fire();
      }
    }
  };

  const on = (type: string) => (e: { instance: { beaconName: string; id: string } }) =>
    push(type, e.instance.beaconName, e.instance.id);

  const sub: BeaconSubscriber = {
    onBeaconInstanceCreated: on("created"),
    onBeaconInstanceRemoved: on("removed"),
    onBeaconStarting: on("starting"),
    onBeaconStarted: on("started"),
    onBeaconReady: on("ready"),
    onBeaconExited: on("exited"),
    onBeaconRestartScheduled: on("restart-scheduled"),
    onBeaconStopped: on("stopped"),
    onBeaconErrored: on("errored"),
    onBeaconStalled: on("stalled"),
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

  const countId = (type: string, id: string) =>
    events.filter((e) => e.type === type && e.id === id).length;

  /** Wait until an event of `type` has been seen for instance `id`. */
  const waitForId = (type: string, id: string, label = `${type} for ${id}`) =>
    waitFor((es) => es.some((e) => e.type === type && e.id === id), label);

  return { sub, events, waitFor, waitForId, count, countId };
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

test("a fatal config error goes to errored and does not restart-loop", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(badConfigBeacon, fx("bad-config-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor((es) => es.some((e) => e.type === "errored" && e.name === "bad-config-b"), "bad-config-b errored");
    const inst = await runner.getInstance("bad-config-b");
    assert.equal(inst?.status, "errored");
    // Even under restart("always"), a fatal config error must not loop.
    await sleep(400);
    assert.equal(rec.count("starting", "bad-config-b"), 1, "did not restart-loop");
    assert.equal(rec.count("restart-scheduled", "bad-config-b"), 0);
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("a runner can be restarted after stop()", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  await rec.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "ready-b"), "first ready");
  await runner.stop({ graceful: true, timeoutMs: 3_000 });

  // Restart the same runner instance — must actually supervise again, not no-op.
  const rec2 = makeRecorder();
  runner.subscribe(rec2.sub);
  runner.start().catch(() => {});
  try {
    await rec2.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "ready-b"), "ready after restart");
    const inst = await runner.getInstance("ready-b");
    assert.equal(inst?.status, "running");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("a bare stop() stops running beacons without marking them errored", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  await rec.waitFor((es) => es.some((e) => e.type === "ready" && e.name === "ready-b"), "ready-b ready");
  await runner.stop(); // non-graceful: SIGKILLs the child
  await sleep(400);
  assert.equal(rec.count("errored", "ready-b"), 0, "shutdown must not mark beacons errored");
});

test("startBeacon during a stop window relaunches instead of stranding", async () => {
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
    // Await stopBeacon (so stopRequested is set), then start again before the
    // child has actually exited — the classic strand race.
    await runner.stopBeacon("ready-b");
    await runner.startBeacon("ready-b");
    await rec.waitFor(
      (es) => es.filter((e) => e.type === "ready" && e.name === "ready-b").length >= 2,
      "ready-b relaunched (not stranded)",
    );
    const inst = await runner.getInstance("ready-b");
    assert.equal(inst?.desiredState, "running");
    assert.equal(inst?.status, "running");
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

test("kills and restarts a beacon that never becomes ready within its startup timeout", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(startupTimeoutBeacon, fx("startup-timeout-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor(
      (es) => es.some((e) => e.type === "stalled" && e.name === "startup-b"),
      "startup-b to hit its startup timeout",
    );
    await rec.waitFor(
      (es) => es.some((e) => e.type === "exited" && e.name === "startup-b"),
      "startup-b to exit after the startup timeout",
    );
    const inst = await runner.getInstance("startup-b");
    assert.equal(inst?.lastExitReason, "startup-timeout");
    assert.match(inst?.lastError ?? "", /Startup timed out/);
    assert.equal(inst?.readyAt, undefined, "never recorded readiness");
    // on-failure policy → the supervisor brings it back up.
    await rec.waitFor(
      (es) => es.filter((e) => e.type === "starting" && e.name === "startup-b").length >= 2,
      "startup-b to restart after timing out",
    );
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("parks a startup-timing-out beacon in errored under a 'never' restart policy", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(startupTimeoutNeverBeacon, fx("startup-timeout-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitFor(
      (es) => es.some((e) => e.type === "errored" && e.name === "startup-never-b"),
      "startup-never-b to error out",
    );
    const inst = await runner.getInstance("startup-never-b");
    assert.equal(inst?.status, "errored");
    assert.equal(inst?.lastExitReason, "startup-timeout");
    // No restart under 'never'.
    assert.equal(rec.count("starting", "startup-never-b"), 1);
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

// ─── Runtime-created instances ────────────────────────────────────────

test("an on-demand beacon seeds no instance until one is created", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(workerBeacon, fx("worker-beacon"));
  runner.start().catch(() => {});
  try {
    await sleep(200);
    assert.deepEqual(await runner.listInstances(), [], "nothing seeded on discovery");
    assert.equal(await runner.getInstance("worker-b"), null);
    // Definition-level start has no instance to act on and says so.
    await assert.rejects(() => runner.startBeacon("worker-b"), /on-demand/);

    const created = await runner.createInstance("worker-b", {
      id: "worker-alpha",
      label: "alpha queue",
      config: { queue: "alpha" },
    });
    assert.equal(created.id, "worker-alpha");
    assert.equal(created.beaconName, "worker-b");
    assert.equal(created.origin, "api");
    assert.equal(created.label, "alpha queue");
    assert.equal(created.desiredState, "running");

    await rec.waitForId("ready", "worker-alpha");
    const inst = await runner.getInstance("worker-alpha");
    assert.equal(inst?.status, "running");
    assert.equal(inst?.config, JSON.stringify({ queue: "alpha" }));
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("several instances of one beacon run concurrently with their own configs", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(workerBeacon, fx("worker-beacon"));
  runner.start().catch(() => {});
  try {
    await runner.createInstance("worker-b", { id: "w-one", config: { queue: "one" } });
    await runner.createInstance("worker-b", { id: "w-two", config: { queue: "two" } });

    await rec.waitForId("ready", "w-one");
    await rec.waitForId("ready", "w-two");

    const instances = await runner.listInstances({ beaconName: "worker-b" });
    assert.equal(instances.length, 2);
    const pids = instances.map((i) => i.pid);
    assert.ok(pids.every((p) => typeof p === "number"), "each instance has its own process");
    assert.notEqual(pids[0], pids[1]);
    assert.deepEqual(
      instances.map((i) => i.config).sort(),
      [JSON.stringify({ queue: "one" }), JSON.stringify({ queue: "two" })].sort(),
    );

    // Stopping one leaves the other running.
    await runner.stopInstance("w-one");
    await rec.waitForId("stopped", "w-one");
    assert.equal((await runner.getInstance("w-one"))?.desiredState, "stopped");
    assert.equal((await runner.getInstance("w-two"))?.status, "running");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("createInstance validates config, rejects duplicate ids, and enforces maxInstances", async () => {
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
  });
  runner.register(workerBeacon, fx("worker-beacon"));
  runner.start().catch(() => {});
  try {
    await assert.rejects(
      () => runner.createInstance("worker-b", { config: { queue: 42 } }),
      /Invalid config/,
    );
    await assert.rejects(
      () => runner.createInstance("nope-b", { config: { queue: "x" } }),
      /not registered/,
    );
    await assert.rejects(
      () => runner.createInstance("worker-b", { id: "bad id!", config: { queue: "x" } }),
      /Invalid instance id/,
    );

    await runner.createInstance("worker-b", { id: "dup", config: { queue: "a" }, start: false });
    await assert.rejects(
      () => runner.createInstance("worker-b", { id: "dup", config: { queue: "b" } }),
      /already exists/,
    );
    // The bare beacon name is reserved for the definition-owned instance.
    await assert.rejects(
      () => runner.createInstance("worker-b", { id: "worker-b", config: { queue: "b" } }),
      /already exists/,
    );

    // maxInstances(3): "dup" plus two more fills the cap.
    await runner.createInstance("worker-b", { id: "cap-2", config: { queue: "b" }, start: false });
    await runner.createInstance("worker-b", { id: "cap-3", config: { queue: "c" }, start: false });
    await assert.rejects(
      () => runner.createInstance("worker-b", { id: "cap-4", config: { queue: "d" } }),
      /its limit/,
    );
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("createInstance with start:false leaves the instance stopped until started", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(workerBeacon, fx("worker-beacon"));
  runner.start().catch(() => {});
  try {
    await runner.createInstance("worker-b", {
      id: "lazy",
      config: { queue: "later" },
      start: false,
    });
    await sleep(250);
    assert.equal(rec.countId("starting", "lazy"), 0, "did not start");
    assert.equal((await runner.getInstance("lazy"))?.desiredState, "stopped");

    await runner.startInstance("lazy");
    await rec.waitForId("ready", "lazy");
    assert.equal((await runner.getInstance("lazy"))?.status, "running");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("deleteInstance stops the process and removes the record", async () => {
  const adapter = new BeaconMemoryAdapter();
  const rec = makeRecorder();
  const runner = new BeaconRunner({ adapter, pollIntervalMs: 25, subscribers: [rec.sub] });
  runner.register(workerBeacon, fx("worker-beacon"));
  runner.start().catch(() => {});
  try {
    await runner.createInstance("worker-b", { id: "ephemeral", config: { queue: "temp" } });
    await rec.waitForId("ready", "ephemeral");

    await runner.deleteInstance("ephemeral");
    assert.equal(await runner.getInstance("ephemeral"), null);
    assert.equal(await adapter.getInstance("ephemeral"), null, "removed from the adapter too");
    assert.equal(rec.countId("removed", "ephemeral"), 1);

    // Gone for good — the supervisor must not resurrect it.
    await sleep(200);
    assert.deepEqual(await runner.listInstances({ beaconName: "worker-b" }), []);
    assert.equal(rec.countId("restart-scheduled", "ephemeral"), 0);

    await assert.rejects(() => runner.deleteInstance("ephemeral"), /not found/);
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("a definition-owned instance cannot be deleted", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitForId("ready", "ready-b");
    await assert.rejects(() => runner.deleteInstance("ready-b"), /cannot be deleted/);
    assert.ok(await runner.getInstance("ready-b"));
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("updateInstance validates and applies a new config on restart", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(workerBeacon, fx("worker-beacon"));
  runner.start().catch(() => {});
  try {
    await runner.createInstance("worker-b", { id: "cfg", config: { queue: "before" } });
    await rec.waitForId("ready", "cfg");

    await assert.rejects(
      () => runner.updateInstance("cfg", { config: { queue: 1 } }),
      /Invalid config/,
    );

    const updated = await runner.updateInstance("cfg", {
      config: { queue: "after" },
      label: "renamed",
      restart: true,
    });
    assert.equal(updated.config, JSON.stringify({ queue: "after" }));
    assert.equal(updated.label, "renamed");

    await rec.waitFor(
      (es) => es.filter((e) => e.type === "ready" && e.id === "cfg").length === 2,
      "cfg ready again after restart",
    );
    const inst = await runner.getInstance("cfg");
    assert.equal(inst?.incarnation, 2);
    assert.equal(inst?.config, JSON.stringify({ queue: "after" }));
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("runtime-created instances are rehydrated from the adapter on restart", async () => {
  // A shared adapter that survives close(), standing in for a durable one.
  const adapter = new BeaconMemoryAdapter();
  adapter.close = async () => {};

  const rec1 = makeRecorder();
  const first = new BeaconRunner({ adapter, pollIntervalMs: 25, subscribers: [rec1.sub] });
  first.register(workerBeacon, fx("worker-beacon"));
  first.start().catch(() => {});
  await first.createInstance("worker-b", { id: "durable", config: { queue: "keepme" } });
  await rec1.waitForId("ready", "durable");
  await first.stop({ graceful: true, timeoutMs: 3_000 });

  const rec2 = makeRecorder();
  const second = new BeaconRunner({ adapter, pollIntervalMs: 25, subscribers: [rec2.sub] });
  second.register(workerBeacon, fx("worker-beacon"));
  second.start().catch(() => {});
  try {
    await rec2.waitForId("ready", "durable");
    const inst = await second.getInstance("durable");
    assert.equal(inst?.origin, "api");
    assert.equal(inst?.config, JSON.stringify({ queue: "keepme" }));
    assert.equal(inst?.status, "running");
  } finally {
    await second.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("an instance whose beacon definition is gone is surfaced as errored, not run", async () => {
  const adapter = new BeaconMemoryAdapter();
  adapter.close = async () => {};

  const rec1 = makeRecorder();
  const first = new BeaconRunner({ adapter, pollIntervalMs: 25, subscribers: [rec1.sub] });
  first.register(workerBeacon, fx("worker-beacon"));
  first.start().catch(() => {});
  await first.createInstance("worker-b", { id: "orphan", config: { queue: "q" } });
  await rec1.waitForId("ready", "orphan");
  await first.stop({ graceful: true, timeoutMs: 3_000 });

  // Second runner never registers worker-b — the definition "disappeared".
  const rec2 = makeRecorder();
  const second = new BeaconRunner({ adapter, pollIntervalMs: 25, subscribers: [rec2.sub] });
  second.start().catch(() => {});
  try {
    await sleep(250);
    const inst = await second.getInstance("orphan");
    assert.equal(inst?.status, "errored");
    assert.match(inst?.lastError ?? "", /not registered/);
    assert.equal(rec2.countId("starting", "orphan"), 0, "never spawned");
    // Desired state is preserved so restoring the definition brings it back.
    assert.equal(inst?.desiredState, "running");
  } finally {
    await second.stop({ graceful: true, timeoutMs: 3_000 });
  }
});

test("stopAllInstances stops the definition instance and every runtime one", async () => {
  const rec = makeRecorder();
  const runner = new BeaconRunner({
    adapter: new BeaconMemoryAdapter(),
    pollIntervalMs: 25,
    subscribers: [rec.sub],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.start().catch(() => {});
  try {
    await rec.waitForId("ready", "ready-b");
    await runner.createInstance("ready-b", { id: "extra-1" });
    await rec.waitForId("ready", "extra-1");

    const stopped = await runner.stopAllInstances("ready-b");
    assert.equal(stopped, 2);
    await rec.waitForId("stopped", "extra-1");
    await rec.waitForId("stopped", "ready-b");
    const states = (await runner.listInstances({ beaconName: "ready-b" })).map(
      (i) => i.desiredState,
    );
    assert.deepEqual(states, ["stopped", "stopped"]);
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 3_000 });
  }
});
