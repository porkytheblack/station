import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LogStore,
  JsonlLogStorage,
  MemoryLogStorage,
  type LogStorageAdapter,
} from "../../src/server/log-store.js";
import type { LogEntry } from "../../src/server/log-buffer.js";

function entry(runId: string, message: string): LogEntry {
  return {
    runId,
    signalName: "sig",
    level: "stdout",
    message,
    timestamp: new Date().toISOString(),
  };
}

function freshJsonl() {
  const dir = mkdtempSync(join(tmpdir(), "station-logs-"));
  const filePath = join(dir, "logs.jsonl");
  const storage = new JsonlLogStorage({ filePath });
  return {
    storage,
    filePath,
    cleanup: async () => {
      // Drain pending writes before deleting the directory.
      await storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const backends: {
  name: string;
  make: () => {
    storage: LogStorageAdapter;
    cleanup: () => void | Promise<void>;
  };
}[] = [
  { name: "memory", make: () => ({ storage: new MemoryLogStorage(), cleanup: () => {} }) },
  { name: "jsonl", make: freshJsonl },
];

for (const { name, make } of backends) {
  test(`[${name}] add + get round-trips`, async () => {
    const { storage, cleanup } = make();
    try {
      const store = new LogStore(storage);
      store.add(entry("r1", "hello"));
      store.add(entry("r1", "world"));
      store.add(entry("r2", "other"));

      const r1 = await store.get("r1");
      assert.equal(r1.length, 2);
      assert.deepEqual(r1.map((e) => e.message), ["hello", "world"]);

      const r2 = await store.get("r2");
      assert.equal(r2.length, 1);
      assert.equal(r2[0].message, "other");
    } finally {
      await cleanup();
    }
  });

  test(`[${name}] get returns empty array for unknown runId`, async () => {
    const { storage, cleanup } = make();
    try {
      const store = new LogStore(storage);
      const logs = await store.get("nope");
      assert.deepEqual(logs, []);
    } finally {
      await cleanup();
    }
  });
}

test("JsonlLogStorage persists across instances", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-logs-"));
  const filePath = join(dir, "logs.jsonl");
  try {
    const a = new LogStore(new JsonlLogStorage({ filePath }));
    a.add(entry("r1", "first"));
    a.add(entry("r1", "second"));
    await a.close();

    const b = new LogStore(new JsonlLogStorage({ filePath }));
    const logs = await b.get("r1");
    assert.equal(logs.length, 2);
    assert.deepEqual(logs.map((e) => e.message), ["first", "second"]);
    await b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonlLogStorage swaps .db path to .jsonl for backwards compat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-logs-"));
  const dbPath = join(dir, "logs.db");
  try {
    const store = new LogStore(new JsonlLogStorage({ filePath: dbPath }));
    store.add(entry("r1", "compat"));
    await store.close();

    const jsonlPath = dbPath.replace(/\.db$/, ".jsonl");
    const content = readFileSync(jsonlPath, "utf8");
    assert.match(content, /"compat"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LogStore(string) constructs a JsonlLogStorage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-logs-"));
  const filePath = join(dir, "logs.jsonl");
  try {
    const store = new LogStore(filePath);
    store.add(entry("r1", "from-string"));
    await store.close();

    const reread = new LogStore(filePath);
    const logs = await reread.get("r1");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].message, "from-string");
    await reread.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LogStore swallows sync adapter throws so signal runs aren't broken", async () => {
  const broken: LogStorageAdapter = {
    add: () => { throw new Error("disk full"); },
    get: () => [],
  };
  const store = new LogStore(broken);
  // Must not throw.
  store.add(entry("r1", "boom"));
  assert.deepEqual(await store.get("r1"), []);
});

test("LogStore swallows async adapter rejections so signal runs aren't broken", async () => {
  const broken: LogStorageAdapter = {
    add: () => Promise.reject(new Error("network down")),
    get: () => [],
  };
  const store = new LogStore(broken);
  store.add(entry("r1", "boom"));
  // Give the rejected promise a tick to surface — verifies our .catch.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await store.get("r1"), []);
});

test("LogStore awaits async adapter get()", async () => {
  let calls = 0;
  const adapter: LogStorageAdapter = {
    add: () => {},
    get: async (runId) => {
      calls++;
      await new Promise((r) => setImmediate(r));
      return runId === "r1" ? [entry("r1", "async")] : [];
    },
  };
  const store = new LogStore(adapter);
  const logs = await store.get("r1");
  assert.equal(calls, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "async");
});

test("LogStore.close awaits adapter close", async () => {
  let closed = false;
  const adapter: LogStorageAdapter = {
    add: () => {},
    get: () => [],
    close: async () => {
      await new Promise((r) => setImmediate(r));
      closed = true;
    },
  };
  const store = new LogStore(adapter);
  await store.close();
  assert.equal(closed, true);
});
