import { test } from "node:test";
import assert from "node:assert/strict";
import { BeaconMemoryAdapter } from "../src/adapters/memory.js";
import type { BeaconInstance } from "../src/types.js";

function makeInstance(id: string, beaconName = id): BeaconInstance {
  const now = new Date();
  return {
    id,
    beaconName,
    origin: id === beaconName ? "definition" : "api",
    status: "backoff",
    desiredState: "running",
    incarnation: 0,
    restartCount: 0,
    nextRestartAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

test("upsert and get round-trip returns a copy, not the stored reference", async () => {
  const a = new BeaconMemoryAdapter();
  const inst = makeInstance("alpha");
  await a.upsertInstance(inst);

  const got = await a.getInstance("alpha");
  assert.ok(got);
  assert.equal(got!.beaconName, "alpha");
  assert.notEqual(got, inst, "returns a defensive copy");

  assert.equal(await a.getInstance("missing"), null);
});

test("updateInstance patches fields and deletes undefined ones", async () => {
  const a = new BeaconMemoryAdapter();
  await a.upsertInstance(makeInstance("beta"));

  await a.updateInstance("beta", { status: "running", pid: 4242 });
  let got = await a.getInstance("beta");
  assert.equal(got!.status, "running");
  assert.equal(got!.pid, 4242);

  await a.updateInstance("beta", { pid: undefined });
  got = await a.getInstance("beta");
  assert.equal(got!.pid, undefined);
});

test("listInstances returns all and removeInstance drops one", async () => {
  const a = new BeaconMemoryAdapter();
  await a.upsertInstance(makeInstance("one"));
  await a.upsertInstance(makeInstance("two"));
  assert.equal((await a.listInstances()).length, 2);

  await a.removeInstance("one");
  const names = (await a.listInstances()).map((i) => i.beaconName);
  assert.deepEqual(names.sort(), ["two"]);
});

test("listInstances filters by beacon name across many instances", async () => {
  const a = new BeaconMemoryAdapter();
  await a.upsertInstance(makeInstance("worker", "worker"));
  await a.upsertInstance(makeInstance("worker-a1", "worker"));
  await a.upsertInstance(makeInstance("worker-b2", "worker"));
  await a.upsertInstance(makeInstance("other"));

  const workers = await a.listInstances({ beaconName: "worker" });
  assert.deepEqual(workers.map((i) => i.id), ["worker", "worker-a1", "worker-b2"]);
  assert.equal((await a.listInstances()).length, 4);
});

test("events are appended and listed newest-first with a limit", async () => {
  const a = new BeaconMemoryAdapter();
  for (let i = 0; i < 5; i++) {
    await a.addEvent({
      id: a.generateId(),
      instanceId: "gamma",
      beaconName: "gamma",
      incarnation: i,
      type: "starting",
      at: new Date(Date.now() + i),
    });
  }
  await a.addEvent({
    id: a.generateId(),
    instanceId: "other",
    beaconName: "other",
    incarnation: 0,
    type: "starting",
    at: new Date(),
  });

  const recent = await a.listEvents("gamma", 2);
  assert.equal(recent.length, 2);
  // newest first → incarnations 4 then 3
  assert.deepEqual(recent.map((e) => e.incarnation), [4, 3]);
});

test("listBeaconEvents spans every instance of a beacon; removal drops an instance's events", async () => {
  const a = new BeaconMemoryAdapter();
  for (const [instanceId, incarnation] of [["w-1", 1], ["w-2", 2]] as const) {
    await a.addEvent({
      id: a.generateId(),
      instanceId,
      beaconName: "worker",
      incarnation,
      type: "starting",
      at: new Date(),
    });
  }

  assert.equal((await a.listBeaconEvents("worker")).length, 2);
  assert.equal((await a.listEvents("w-1")).length, 1);

  await a.removeInstance("w-1");
  assert.equal((await a.listEvents("w-1")).length, 0);
  assert.equal((await a.listBeaconEvents("worker")).length, 1);
});

test("generateId is unique and ping resolves true", async () => {
  const a = new BeaconMemoryAdapter();
  assert.notEqual(a.generateId(), a.generateId());
  assert.equal(await a.ping(), true);
});
