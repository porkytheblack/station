import { test } from "node:test";
import assert from "node:assert/strict";
import { BeaconMemoryAdapter } from "../src/adapters/memory.js";
import type { BeaconInstance } from "../src/types.js";

function makeInstance(name: string): BeaconInstance {
  const now = new Date();
  return {
    beaconName: name,
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

test("events are appended and listed newest-first with a limit", async () => {
  const a = new BeaconMemoryAdapter();
  for (let i = 0; i < 5; i++) {
    await a.addEvent({
      id: a.generateId(),
      beaconName: "gamma",
      incarnation: i,
      type: "starting",
      at: new Date(Date.now() + i),
    });
  }
  await a.addEvent({
    id: a.generateId(),
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

test("generateId is unique and ping resolves true", async () => {
  const a = new BeaconMemoryAdapter();
  assert.notEqual(a.generateId(), a.generateId());
  assert.equal(await a.ping(), true);
});
