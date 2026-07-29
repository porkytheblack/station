import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
  const beaconName = over.beaconName ?? "web";
  return {
    id: over.id ?? beaconName,
    beaconName,
    origin: "definition",
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

test("upsert replaces an existing instance (same id)", async () => {
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

test("many instances of one beacon coexist and can be listed per beacon", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.upsertInstance(fixture({ beaconName: "worker" }));
    await adapter.upsertInstance(
      fixture({ id: "worker-a1", beaconName: "worker", origin: "api", label: "tenant a" }),
    );
    await adapter.upsertInstance(fixture({ id: "worker-b2", beaconName: "worker", origin: "api" }));
    await adapter.upsertInstance(fixture({ beaconName: "api" }));

    const workers = await adapter.listInstances({ beaconName: "worker" });
    assert.deepEqual(workers.map((i) => i.id), ["worker", "worker-a1", "worker-b2"]);
    assert.equal(workers[1].origin, "api");
    assert.equal(workers[1].label, "tenant a");
    assert.equal((await adapter.listInstances()).length, 4);

    await adapter.removeInstance("worker-a1");
    assert.equal((await adapter.listInstances({ beaconName: "worker" })).length, 2);
  } finally { cleanup(); }
});

test("events append and list newest-first with a limit", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    for (let i = 0; i < 5; i++) {
      await adapter.addEvent({
        id: adapter.generateId(),
        instanceId: "web",
        beaconName: "web",
        incarnation: i,
        type: "starting",
        at: new Date(), // same-ms collisions are disambiguated by seq
      });
    }
    await adapter.addEvent({ id: adapter.generateId(), instanceId: "other", beaconName: "other", incarnation: 0, type: "ready", at: new Date() });

    const recent = await adapter.listEvents("web", 2);
    assert.equal(recent.length, 2);
    assert.deepEqual(recent.map((e) => e.incarnation), [4, 3], "newest first");
  } finally { cleanup(); }
});

test("events are scoped per instance but a beacon-wide timeline spans them", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.addEvent({ id: adapter.generateId(), instanceId: "worker", beaconName: "worker", incarnation: 1, type: "starting", at: new Date() });
    await adapter.addEvent({ id: adapter.generateId(), instanceId: "worker-a1", beaconName: "worker", incarnation: 1, type: "starting", at: new Date() });
    await adapter.addEvent({ id: adapter.generateId(), instanceId: "worker-a1", beaconName: "worker", incarnation: 1, type: "ready", at: new Date() });

    assert.equal((await adapter.listEvents("worker-a1")).length, 2);
    assert.equal((await adapter.listEvents("worker")).length, 1);
    assert.equal((await adapter.listBeaconEvents("worker")).length, 3);
    assert.equal((await adapter.listBeaconEvents("worker"))[0].type, "ready", "newest first");

    // Deleting an instance takes its events with it.
    await adapter.removeInstance("worker-a1");
    assert.equal((await adapter.listEvents("worker-a1")).length, 0);
    assert.equal((await adapter.listBeaconEvents("worker")).length, 1);
  } finally { cleanup(); }
});

test("state is durable across reopen", async () => {
  const { adapter, dbPath, cleanup } = freshDb();
  try {
    await adapter.upsertInstance(fixture({ beaconName: "web", incarnation: 7, desiredState: "stopped" }));
    await adapter.addEvent({ id: adapter.generateId(), instanceId: "web", beaconName: "web", incarnation: 7, type: "stopped", at: new Date() });
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

test("migrates a pre-multi-instance database without losing state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-beacon-legacy-"));
  const dbPath = join(dir, "station.db");
  try {
    // Recreate the exact schema shipped before instances existed: records keyed
    // by beacon_name, events with no instance_id.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE beacon_instances (
        beacon_name        TEXT PRIMARY KEY,
        status             TEXT NOT NULL,
        desired_state      TEXT NOT NULL,
        incarnation        INTEGER NOT NULL DEFAULT 0,
        restart_count      INTEGER NOT NULL DEFAULT 0,
        pid                INTEGER,
        config             TEXT,
        started_at         TEXT,
        ready_at           TEXT,
        last_heartbeat_at  TEXT,
        last_exit_at       TEXT,
        last_exit_reason   TEXT,
        last_error         TEXT,
        next_restart_at    TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE TABLE beacon_events (
        id          TEXT PRIMARY KEY,
        beacon_name TEXT NOT NULL,
        incarnation INTEGER NOT NULL,
        type        TEXT NOT NULL,
        message     TEXT,
        at          TEXT NOT NULL,
        seq         INTEGER
      );
    `);
    const now = new Date().toISOString();
    legacy
      .prepare(
        `INSERT INTO beacon_instances
           (beacon_name, status, desired_state, incarnation, restart_count, config, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("web", "running", "running", 9, 2, JSON.stringify({ port: 8080 }), now, now);
    legacy
      .prepare(`INSERT INTO beacon_events (id, beacon_name, incarnation, type, at, seq) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("e1", "web", 9, "ready", now, 1);
    legacy.close();

    const adapter = new BeaconSqliteAdapter({ dbPath });
    try {
      // The old record becomes the beacon's definition-owned instance, keeping
      // its id (the beacon name), desired state, and counters.
      const got = await adapter.getInstance("web");
      assert.equal(got?.id, "web");
      assert.equal(got?.beaconName, "web");
      assert.equal(got?.origin, "definition");
      assert.equal(got?.desiredState, "running");
      assert.equal(got?.incarnation, 9);
      assert.equal(got?.restartCount, 2);
      assert.equal(got?.config, JSON.stringify({ port: 8080 }));

      const events = await adapter.listEvents("web");
      assert.equal(events.length, 1);
      assert.equal(events[0].instanceId, "web");
      assert.equal((await adapter.listBeaconEvents("web")).length, 1);

      // And the migrated database accepts runtime-created instances.
      await adapter.upsertInstance({
        id: "web-a1",
        beaconName: "web",
        origin: "api",
        status: "backoff",
        desiredState: "running",
        incarnation: 0,
        restartCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      assert.equal((await adapter.listInstances({ beaconName: "web" })).length, 2);
    } finally {
      await adapter.close();
    }

    // Re-opening an already-migrated database is a no-op.
    const reopened = new BeaconSqliteAdapter({ dbPath });
    assert.equal((await reopened.listInstances()).length, 2);
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
