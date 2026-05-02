import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleSqliteAdapter } from "../src/schedules.js";
import type { Schedule } from "station-schedules";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "station-schedules-"));
  const dbPath = join(dir, "station.db");
  const adapter = new ScheduleSqliteAdapter({ dbPath });
  return {
    adapter,
    cleanup: () => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fixture = (over: Partial<Schedule> = {}): Schedule => {
  const now = new Date();
  return {
    id: over.id ?? "s1",
    kind: "signal",
    target: "ping",
    interval: "5m",
    enabled: true,
    nextRunAt: new Date(now.getTime() - 1000),
    createdAt: now,
    updatedAt: now,
    ...over,
  };
};

test("add + get round-trips with all fields", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture({ input: { foo: 1 }, createdBy: "key_abc" }));
    const got = await adapter.get("s1");
    assert.equal(got?.target, "ping");
    assert.deepEqual(got?.input, { foo: 1 });
    assert.equal(got?.createdBy, "key_abc");
  } finally { cleanup(); }
});

test("list filters by kind / enabled / due", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture({ id: "a", kind: "signal", enabled: true }));
    await adapter.add(fixture({
      id: "b",
      kind: "broadcast-dynamic",
      enabled: true,
      nextRunAt: new Date(Date.now() + 60_000), // future
    }));
    await adapter.add(fixture({ id: "c", kind: "signal", enabled: false }));

    assert.equal((await adapter.list({ kind: "signal" })).length, 2);
    assert.equal((await adapter.list({ enabled: true })).length, 2);
    const due = await adapter.list({ due: true });
    assert.equal(due.length, 1);
    assert.equal(due[0].id, "a");
  } finally { cleanup(); }
});

test("update applies a patch and bumps updated_at", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture());
    const before = (await adapter.get("s1"))!.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await adapter.update("s1", { interval: "1h" });
    const after = await adapter.get("s1");
    assert.equal(after?.interval, "1h");
    assert.ok(after!.updatedAt.getTime() > before.getTime());
  } finally { cleanup(); }
});

test("claimDue advances and returns true on a matching nextRunAt", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const due = new Date(Date.now() - 1000);
    const newNext = new Date(Date.now() + 60_000);
    await adapter.add(fixture({ nextRunAt: due }));
    const ok = await adapter.claimDue("s1", due, newNext);
    assert.equal(ok, true);
    const after = await adapter.get("s1");
    assert.equal(after?.nextRunAt.getTime(), newNext.getTime());
  } finally { cleanup(); }
});

test("claimDue returns false when nextRunAt has changed", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const original = new Date(Date.now() - 1000);
    const advanced = new Date(Date.now() + 30_000);
    await adapter.add(fixture({ nextRunAt: original }));
    // Some other worker advanced first.
    await adapter.update("s1", { nextRunAt: advanced });
    const ok = await adapter.claimDue("s1", original, new Date(Date.now() + 60_000));
    assert.equal(ok, false);
  } finally { cleanup(); }
});

test("claimDue returns false on disabled schedules", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    const due = new Date(Date.now() - 1000);
    await adapter.add(fixture({ nextRunAt: due, enabled: false }));
    const ok = await adapter.claimDue("s1", due, new Date(Date.now() + 60_000));
    assert.equal(ok, false);
  } finally { cleanup(); }
});

test("delete removes the schedule", async () => {
  const { adapter, cleanup } = freshDb();
  try {
    await adapter.add(fixture());
    assert.equal(await adapter.delete("s1"), true);
    assert.equal(await adapter.get("s1"), null);
    assert.equal(await adapter.delete("s1"), false);
  } finally { cleanup(); }
});
