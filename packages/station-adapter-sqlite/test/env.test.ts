import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSqliteAdapter } from "../src/env.js";
import type { EnvVar } from "station-env";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "station-env-"));
  const dbPath = join(dir, "station.db");
  const adapter = new EnvSqliteAdapter({ dbPath });
  return {
    adapter,
    cleanup: () => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fixture = (over: Partial<EnvVar> = {}): EnvVar => {
  const now = new Date();
  return {
    id: over.id ?? "e1",
    key: "API_KEY",
    value: "secret-value",
    secret: false,
    targets: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

test("add + get round-trips all fields including targets", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture({
      secret: true,
      targets: [{ kind: "signal", name: "a" }, { kind: "beacon", name: "b" }],
      createdBy: "key_abc",
    }));
    const got = await adapter.get("e1");
    assert.ok(got);
    assert.equal(got.key, "API_KEY");
    assert.equal(got.value, "secret-value");
    assert.equal(got.secret, true);
    assert.deepEqual(got.targets, [{ kind: "signal", name: "a" }, { kind: "beacon", name: "b" }]);
    assert.equal(got.createdBy, "key_abc");
    assert.ok(got.createdAt instanceof Date);
  } finally {
    cleanup();
  }
});

test("list returns all vars sorted by key", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture({ id: "e1", key: "ZED" }));
    await adapter.add(fixture({ id: "e2", key: "ALPHA" }));
    const list = await adapter.list();
    assert.deepEqual(list.map((v) => v.key), ["ALPHA", "ZED"]);
  } finally {
    cleanup();
  }
});

test("update changes value and targets", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture());
    await adapter.update("e1", { value: "new", targets: [{ kind: "signal", name: "x" }] });
    const got = await adapter.get("e1");
    assert.equal(got?.value, "new");
    assert.deepEqual(got?.targets, [{ kind: "signal", name: "x" }]);
  } finally {
    cleanup();
  }
});

test("delete removes the var", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture());
    assert.equal(await adapter.delete("e1"), true);
    assert.equal(await adapter.get("e1"), null);
    assert.equal(await adapter.delete("e1"), false);
  } finally {
    cleanup();
  }
});

test("persists across adapter instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-env-"));
  const dbPath = join(dir, "station.db");
  try {
    const a1 = new EnvSqliteAdapter({ dbPath });
    await a1.add(fixture({ targets: [{ kind: "beacon", name: "worker" }] }));
    await a1.close();

    const a2 = new EnvSqliteAdapter({ dbPath });
    const got = await a2.get("e1");
    assert.deepEqual(got?.targets, [{ kind: "beacon", name: "worker" }]);
    await a2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
