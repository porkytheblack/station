import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvStore, FileEnvStorage } from "../src/index.js";

test("FileEnvStorage persists vars across store instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-env-"));
  const filePath = join(dir, "env.json");
  try {
    const store1 = new EnvStore(new FileEnvStorage({ filePath }), { cacheTtlMs: 0 });
    await store1.create({ key: "PERSISTED", value: "yes", targets: [{ kind: "beacon", name: "b" }] });
    await store1.close();

    // A fresh store over the same file sees the persisted var, targets intact.
    const store2 = new EnvStore(new FileEnvStorage({ filePath }), { cacheTtlMs: 0 });
    const resolved = await store2.resolveFor({ kind: "beacon", name: "b" });
    assert.equal(resolved.PERSISTED, "yes");
    const list = await store2.list();
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].targets, [{ kind: "beacon", name: "b" }]);
    await store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEnvStorage round-trips secret flag and dates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-env-"));
  const filePath = join(dir, "env.json");
  try {
    const store1 = new EnvStore(new FileEnvStorage({ filePath }), { cacheTtlMs: 0 });
    const created = await store1.create({ key: "S", value: "v", secret: true });
    await store1.close();

    const store2 = new EnvStore(new FileEnvStorage({ filePath }), { cacheTtlMs: 0 });
    const got = await store2.get(created.id);
    assert.ok(got);
    assert.equal(got.secret, true);
    assert.ok(got.createdAt instanceof Date);
    assert.equal(got.createdAt.getTime(), created.createdAt.getTime());
    await store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
