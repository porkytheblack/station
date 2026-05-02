import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BroadcastSqliteAdapter } from "../src/broadcast.js";
import type { DynamicBroadcastSpec } from "station-broadcast";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "station-sqlite-"));
  const dbPath = join(dir, "station.db");
  const adapter = new BroadcastSqliteAdapter({ dbPath });
  return {
    adapter,
    cleanup: () => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const draft = (over: Partial<DynamicBroadcastSpec> = {}): DynamicBroadcastSpec => ({
  name: "myBroadcast",
  version: 0, // overwritten by adapter
  failurePolicy: "fail-fast",
  nodes: [{ name: "first", signalName: "send", dependsOn: [] }],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

test("saveDefinition assigns version 1 on first save", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const saved = await adapter.saveDefinition(draft());
    assert.equal(saved.version, 1);
  } finally { cleanup(); }
});

test("saveDefinition increments version on each save", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const v1 = await adapter.saveDefinition(draft());
    const v2 = await adapter.saveDefinition(draft());
    const v3 = await adapter.saveDefinition(draft());
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.equal(v3.version, 3);
  } finally { cleanup(); }
});

test("getDefinition without version returns the latest", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.saveDefinition(draft());
    await adapter.saveDefinition(draft({ failurePolicy: "skip-downstream" }));
    const got = await adapter.getDefinition("myBroadcast");
    assert.equal(got?.version, 2);
    assert.equal(got?.failurePolicy, "skip-downstream");
  } finally { cleanup(); }
});

test("getDefinition with explicit version returns that version", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.saveDefinition(draft());
    await adapter.saveDefinition(draft());
    const v1 = await adapter.getDefinition("myBroadcast", 1);
    assert.equal(v1?.version, 1);
  } finally { cleanup(); }
});

test("listDefinitions returns the latest version of each name, soft-deleted excluded", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.saveDefinition(draft({ name: "a" }));
    await adapter.saveDefinition(draft({ name: "b" }));
    await adapter.saveDefinition(draft({ name: "b" })); // bump to v2
    const list = await adapter.listDefinitions();
    assert.equal(list.length, 2);
    const b = list.find((d) => d.name === "b");
    assert.equal(b?.version, 2);

    await adapter.deleteDefinition("a");
    const list2 = await adapter.listDefinitions();
    assert.equal(list2.length, 1);
    assert.equal(list2[0].name, "b");
  } finally { cleanup(); }
});

test("listDefinitionVersions returns all versions newest-first", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.saveDefinition(draft());
    await adapter.saveDefinition(draft());
    await adapter.saveDefinition(draft());
    const versions = await adapter.listDefinitionVersions("myBroadcast");
    assert.deepEqual(versions.map((v) => v.version), [3, 2, 1]);
  } finally { cleanup(); }
});

test("deleteDefinition is soft + version monotonicity holds across recreate", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.saveDefinition(draft());
    await adapter.saveDefinition(draft());
    assert.equal(await adapter.deleteDefinition("myBroadcast"), true);
    // Soft-delete: history retained
    const versions = await adapter.listDefinitionVersions("myBroadcast");
    assert.equal(versions.length, 2);
    assert.ok(versions[0].deletedAt instanceof Date);

    // Re-creating after delete continues at v3, NOT v1.
    const v3 = await adapter.saveDefinition(draft());
    assert.equal(v3.version, 3);
    // Listing now shows it again (no longer deleted).
    const list = await adapter.listDefinitions();
    assert.equal(list.length, 1);
    assert.equal(list[0].version, 3);
  } finally { cleanup(); }
});

test("definitionSnapshot column round-trips on broadcast runs", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const snapshot = JSON.stringify({ x: 1, y: "hello" });
    await adapter.addBroadcastRun({
      id: "run-1",
      broadcastName: "x",
      input: "{}",
      status: "pending",
      failurePolicy: "fail-fast",
      createdAt: new Date(),
      definitionSnapshot: snapshot,
    });
    const got = await adapter.getBroadcastRun("run-1");
    assert.equal(got?.definitionSnapshot, snapshot);
  } finally { cleanup(); }
});
