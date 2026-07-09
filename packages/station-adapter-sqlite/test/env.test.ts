import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvSqliteAdapter } from "../src/env.js";
import { EnvStore } from "station-env";
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

test("a value-only update (explicit undefined secret/targets) preserves them", async () => {
  // Reproduces the durable-adapter bug: EnvStore.update always sends
  // { value, secret: undefined, targets: undefined }. Writing NULL for the
  // undefined fields would violate the NOT NULL columns / wipe the scope.
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture({ secret: true, targets: [{ kind: "signal", name: "keep" }] }));
    await adapter.update("e1", { value: "rotated", secret: undefined, targets: undefined });
    const got = await adapter.get("e1");
    assert.equal(got?.value, "rotated");
    assert.equal(got?.secret, true, "secret must be preserved");
    assert.deepEqual(got?.targets, [{ kind: "signal", name: "keep" }], "targets must be preserved");
  } finally {
    cleanup();
  }
});

test("EnvStore value rotation over SQLite keeps a scoped secret scoped", async () => {
  // End-to-end path the dashboard/API exercises: rotate a secret's value with
  // a value-only PATCH and confirm it stays secret + scoped (no crash, no
  // scope escalation).
  const { adapter, cleanup } = freshDb();
  try {
    const store = new EnvStore(adapter, { cacheTtlMs: 0 });
    const v = await store.create({
      key: "STRIPE_KEY",
      value: "sk_old",
      secret: true,
      targets: [{ kind: "signal", name: "charge" }],
    });
    await store.update(v.id, { value: "sk_new" });

    const forCharge = await store.resolveFor({ kind: "signal", name: "charge" });
    const forOther = await store.resolveFor({ kind: "signal", name: "other" });
    assert.equal(forCharge.STRIPE_KEY, "sk_new", "value rotated for the scoped target");
    assert.equal(forOther.STRIPE_KEY, undefined, "still not injected into other signals");

    const pub = await store.getPublic(v.id);
    assert.equal(pub?.secret, true);
    assert.equal(pub?.value, null, "still redacted");
    assert.deepEqual(pub?.targets, [{ kind: "signal", name: "charge" }]);
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
