import { test } from "node:test";
import assert from "node:assert/strict";
import { EnvStore, EnvValidationError, MemoryEnvStorage, missingEnvKeys } from "../src/index.js";

function makeStore(): EnvStore {
  return new EnvStore(new MemoryEnvStorage(), { cacheTtlMs: 0 });
}

test("create + resolveFor injects global vars into every target", async () => {
  const store = makeStore();
  await store.create({ key: "GLOBAL_ONE", value: "g1" });

  const forSignal = await store.resolveFor({ kind: "signal", name: "a" });
  const forBeacon = await store.resolveFor({ kind: "beacon", name: "b" });
  assert.equal(forSignal.GLOBAL_ONE, "g1");
  assert.equal(forBeacon.GLOBAL_ONE, "g1");
});

test("scoped vars only reach their targets", async () => {
  const store = makeStore();
  await store.create({ key: "SCOPED", value: "s", targets: [{ kind: "signal", name: "a" }] });

  const forA = await store.resolveFor({ kind: "signal", name: "a" });
  const forB = await store.resolveFor({ kind: "signal", name: "b" });
  assert.equal(forA.SCOPED, "s");
  assert.equal(forB.SCOPED, undefined);
});

test("scoped var overrides a global var with the same key", async () => {
  const store = makeStore();
  await store.create({ key: "DB_URL", value: "global-db" });
  await store.create({ key: "DB_URL", value: "signal-db", targets: [{ kind: "signal", name: "a" }] });

  const forA = await store.resolveFor({ kind: "signal", name: "a" });
  const forB = await store.resolveFor({ kind: "signal", name: "b" });
  assert.equal(forA.DB_URL, "signal-db");
  assert.equal(forB.DB_URL, "global-db");
});

test("two globals with the same key conflict", async () => {
  const store = makeStore();
  await store.create({ key: "K", value: "1" });
  await assert.rejects(() => store.create({ key: "K", value: "2" }), EnvValidationError);
});

test("two vars scoped to the same target with the same key conflict", async () => {
  const store = makeStore();
  await store.create({ key: "K", value: "1", targets: [{ kind: "signal", name: "a" }] });
  await assert.rejects(
    () => store.create({ key: "K", value: "2", targets: [{ kind: "signal", name: "a" }] }),
    EnvValidationError,
  );
});

test("same key scoped to disjoint targets is allowed", async () => {
  const store = makeStore();
  await store.create({ key: "K", value: "1", targets: [{ kind: "signal", name: "a" }] });
  await assert.doesNotReject(
    () => store.create({ key: "K", value: "2", targets: [{ kind: "signal", name: "b" }] }),
  );
});

test("invalid keys are rejected", async () => {
  const store = makeStore();
  await assert.rejects(() => store.create({ key: "1BAD", value: "x" }), EnvValidationError);
  await assert.rejects(() => store.create({ key: "has space", value: "x" }), EnvValidationError);
});

test("reserved keys (PATH, NODE_OPTIONS, STATION_*) are rejected", async () => {
  const store = makeStore();
  for (const key of ["PATH", "NODE_OPTIONS", "LD_PRELOAD", "STATION_SIGNAL_RUN_ID"]) {
    await assert.rejects(() => store.create({ key, value: "x" }), EnvValidationError, key);
  }
});

test("secret values are redacted in public listings but present in resolve", async () => {
  const store = makeStore();
  await store.create({ key: "SECRET", value: "sk_live_123", secret: true });

  const pub = await store.listPublic();
  assert.equal(pub[0].value, null);
  assert.equal(pub[0].secret, true);

  const resolved = await store.resolveFor({ kind: "signal", name: "a" });
  assert.equal(resolved.SECRET, "sk_live_123");
});

test("a secret var cannot be downgraded to non-secret via update", async () => {
  const store = makeStore();
  const v = await store.create({ key: "SECRET", value: "x", secret: true });
  await store.update(v.id, { secret: false, value: "y" });
  const pub = await store.getPublic(v.id);
  assert.equal(pub?.secret, true);
  assert.equal(pub?.value, null);
});

test("update can change value and re-resolves", async () => {
  const store = makeStore();
  const v = await store.create({ key: "K", value: "old" });
  await store.update(v.id, { value: "new" });
  const resolved = await store.resolveFor({ kind: "signal", name: "a" });
  assert.equal(resolved.K, "new");
});

test("update rejects targets that would collide with another var", async () => {
  const store = makeStore();
  await store.create({ key: "K", value: "1", targets: [{ kind: "signal", name: "a" }] });
  const v2 = await store.create({ key: "K", value: "2", targets: [{ kind: "signal", name: "b" }] });
  await assert.rejects(
    () => store.update(v2.id, { targets: [{ kind: "signal", name: "a" }] }),
    EnvValidationError,
  );
});

test("delete removes the var from resolution", async () => {
  const store = makeStore();
  const v = await store.create({ key: "K", value: "1" });
  assert.equal(await store.delete(v.id), true);
  const resolved = await store.resolveFor({ kind: "signal", name: "a" });
  assert.equal(resolved.K, undefined);
});

test("missingEnvKeys reports keys absent from both store map and process env", () => {
  const resolved = { PRESENT: "1" };
  const procEnv = { HOST_VAR: "h" };
  const missing = missingEnvKeys(["PRESENT", "HOST_VAR", "GONE"], resolved, procEnv);
  assert.deepEqual(missing, ["GONE"]);
});
