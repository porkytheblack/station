import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KeyStore,
  FileKeyStorage,
  MemoryKeyStorage,
  SqliteKeyStorage,
  type ApiKeyStorageAdapter,
} from "../../../src/server/auth/keys.js";

function freshSqlite() {
  const dir = mkdtempSync(join(tmpdir(), "station-keys-"));
  const dbPath = join(dir, "keys.db");
  const storage = new SqliteKeyStorage({ dbPath });
  return {
    storage,
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function freshFile() {
  const dir = mkdtempSync(join(tmpdir(), "station-keys-"));
  const filePath = join(dir, "keys.json");
  const storage = new FileKeyStorage({ filePath });
  return {
    storage,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const backends: { name: string; make: () => { storage: ApiKeyStorageAdapter; cleanup: () => void } }[] = [
  { name: "memory", make: () => ({ storage: new MemoryKeyStorage(), cleanup: () => {} }) },
  { name: "file", make: freshFile },
  { name: "sqlite", make: freshSqlite },
];

for (const { name, make } of backends) {
  test(`[${name}] create + verify round-trips`, async () => {
    const { storage, cleanup } = make();
    try {
      const ks = new KeyStore(storage);
      const { key, record } = await ks.create("test", ["read"]);
      assert.match(key, /^sk_live_/);
      assert.equal(record.keyPrefix.length, 12);
      assert.deepEqual(record.scopes, ["read"]);

      const verified = await ks.verify(key);
      assert.ok(verified);
      assert.equal(verified.id, record.id);
      assert.deepEqual(verified.scopes, ["read"]);
    } finally { cleanup(); }
  });

  test(`[${name}] verify returns null for unknown key`, async () => {
    const { storage, cleanup } = make();
    try {
      const ks = new KeyStore(storage);
      const result = await ks.verify("sk_live_nope");
      assert.equal(result, null);
    } finally { cleanup(); }
  });

  test(`[${name}] verify returns null for revoked keys`, async () => {
    const { storage, cleanup } = make();
    try {
      const ks = new KeyStore(storage);
      const { key, record } = await ks.create("test");
      assert.equal(await ks.revoke(record.id), true);
      const verified = await ks.verify(key);
      assert.equal(verified, null);
    } finally { cleanup(); }
  });

  test(`[${name}] list returns no key hashes`, async () => {
    const { storage, cleanup } = make();
    try {
      const ks = new KeyStore(storage);
      await ks.create("a");
      await ks.create("b");
      const list = await ks.list();
      assert.equal(list.length, 2);
      // Type-level guarantee: keyHash is not in the public type. Spot-check
      // there's no `keyHash` field surfaced.
      for (const k of list) {
        assert.equal((k as Record<string, unknown>).keyHash, undefined);
      }
    } finally { cleanup(); }
  });

  test(`[${name}] revoke is idempotent on unknown ids`, async () => {
    const { storage, cleanup } = make();
    try {
      const ks = new KeyStore(storage);
      assert.equal(await ks.revoke("nope"), false);
    } finally { cleanup(); }
  });
}

test("FileKeyStorage persists across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-keys-"));
  const filePath = join(dir, "keys.json");
  try {
    const ks1 = new KeyStore(new FileKeyStorage({ filePath }));
    const { key } = await ks1.create("persisted");

    const ks2 = new KeyStore(new FileKeyStorage({ filePath }));
    const verified = await ks2.verify(key);
    assert.ok(verified);
    assert.equal(verified.name, "persisted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backwards-compat: KeyStore(string) constructs a FileKeyStorage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-keys-"));
  const filePath = join(dir, "keys.json");
  try {
    const ks = new KeyStore(filePath);
    const { key } = await ks.create("compat");
    const verified = await ks.verify(key);
    assert.ok(verified);
    await ks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backwards-compat: KeyStore(string) with .db path swaps to .json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-keys-"));
  const dbPath = join(dir, "keys.db");
  try {
    const ks = new KeyStore(dbPath);
    const { key } = await ks.create("compat-db");
    const verified = await ks.verify(key);
    assert.ok(verified);
    await ks.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom storage adapter is honored", async () => {
  // Tiny in-memory mock that lets us spy on calls.
  let inserted = 0;
  let touched = 0;
  const mock: ApiKeyStorageAdapter = {
    insert: () => { inserted++; },
    findByHash: () => null,
    list: () => [],
    touch: () => { touched++; },
    revoke: () => true,
  };
  const ks = new KeyStore(mock);
  await ks.create("x");
  assert.equal(inserted, 1);
  await ks.verify("sk_live_unknown"); // misses, no touch
  assert.equal(touched, 0);
});
