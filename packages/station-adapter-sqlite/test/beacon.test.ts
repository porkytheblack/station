import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BeaconSqliteAdapter } from "../src/beacon.js";
import type { BeaconInstance } from "station-beacon";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "station-beacon-"));
  const dbPath = join(dir, "station.db");
  const adapter = new BeaconSqliteAdapter({ dbPath });
  return {
    adapter,
    dbPath,
    cleanup: () => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fixture = (over: Partial<BeaconInstance> = {}): BeaconInstance => {
  const now = new Date();
  return {
    beaconName: "web",
    status: "running",
    desiredState: "running",
    incarnation: 1,
    restartCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

test("upsert + get round-trips all fields", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    await adapter.upsertInstance(fixture({
      pid: 4242,
      config: JSON.stringify({ port: 8080 }),
      startedAt,
      readyAt: startedAt,
      lastExitReason: "failure",
      lastError: "boom",
    }));
    const got = await adapter.getInstance("web");
    assert.equal(got?.status, "running");
    assert.equal(got?.pid, 4242);
    assert.equal(got?.config, JSON.stringify({ port: 8080 }));
    assert.equal(got?.startedAt?.toISOString(), startedAt.toISOString());
    assert.equal(got?.lastExitReason, "failure");
    assert.equal(got?.lastError, "boom");
    assert.equal(await adapter.getInstance("missing"), null);
  } finally { cleanup(); }
});

test("upsert replaces an existing instance (same name)", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.upsertInstance(fixture({ incarnation: 1 }));
    await adapter.upsertInstance(fixture({ incarnation: 2, status: "backoff" }));
    const got = await adapter.getInstance("web");
    assert.equal(got?.incarnation, 2);
    assert.equal(got?.status, "backoff");
    assert.equal((await adapter.listInstances()).length, 1);
  } finally { cleanup(); }
});

test("updateInstance patches fields, clears undefined, bumps updated_at", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.upsertInstance(fixture({ pid: 111 }));
    const before = (await adapter.getInstance("web"))!.updatedAt;
    await new Promise((r) => setTimeout(r, 10));

    await adapter.updateInstance("web", { status: "stopping", restartCount: 3 });
    let got = await adapter.getInstance("web");
    assert.equal(got?.status, "stopping");
    assert.equal(got?.restartCount, 3);
    assert.ok(got!.updatedAt.getTime() > before.getTime(), "updated_at bumped");

    await adapter.updateInstance("web", { pid: undefined });
    got = await adapter.getInstance("web");
    assert.equal(got?.pid, undefined);
  } finally { cleanup(); }
});

test("listInstances returns all, ordered by name; removeInstance drops one", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.upsertInstance(fixture({ beaconName: "worker" }));
    await adapter.upsertInstance(fixture({ beaconName: "api" }));
    const names = (await adapter.listInstances()).map((i) => i.beaconName);
    assert.deepEqual(names, ["api", "worker"]);

    await adapter.removeInstance("api");
    assert.deepEqual((await adapter.listInstances()).map((i) => i.beaconName), ["worker"]);
  } finally { cleanup(); }
});

test("events append and list newest-first with a limit", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    for (let i = 0; i < 5; i++) {
      await adapter.addEvent({
        id: adapter.generateId(),
        beaconName: "web",
        incarnation: i,
        type: "starting",
        at: new Date(), // same-ms collisions are disambiguated by seq
      });
    }
    await adapter.addEvent({ id: adapter.generateId(), beaconName: "other", incarnation: 0, type: "ready", at: new Date() });

    const recent = await adapter.listEvents("web", 2);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent.map((e) => e.incarnation), [4, 3], "newest first");
  } finally { cleanup(); }
});

test("state is durable across reopen", async () => {
  const { adapter, dbPath, cleanup } = freshDb();
  try {
    await adapter.upsertInstance(fixture({ beaconName: "web", incarnation: 7, desiredState: "stopped" }));
    await adapter.addEvent({ id: adapter.generateId(), beaconName: "web", incarnation: 7, type: "stopped", at: new Date() });
    await adapter.close();

    const reopened = new BeaconSqliteAdapter({ dbPath });
    const got = await reopened.getInstance("web");
    assert.equal(got?.incarnation, 7);
    assert.equal(got?.desiredState, "stopped");
    assert.equal((await reopened.listEvents("web")).length, 1);
    await reopened.close();
  } finally { cleanup(); }
});

test("generateId is unique and ping resolves true", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    assert.notEqual(adapter.generateId(), adapter.generateId());
    assert.equal(await adapter.ping(), true);
  } finally { cleanup(); }
});
