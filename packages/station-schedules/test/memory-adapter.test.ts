import { test } from "node:test";
import assert from "node:assert/strict";
import { ScheduleMemoryAdapter, type Schedule } from "../src/index.js";

function fixture(over: Partial<Schedule> = {}): Schedule {
  const now = new Date();
  return {
    id: over.id ?? "s1",
    kind: "signal",
    target: "sendEmail",
    interval: "5m",
    enabled: true,
    nextRunAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

test("add + get round-trips", async () => {
  const a = new ScheduleMemoryAdapter();
  const s = fixture();
  await a.add(s);
  const got = await a.get("s1");
  assert.equal(got?.id, "s1");
  assert.equal(got?.target, "sendEmail");
});

test("add rejects duplicate ids", async () => {
  const a = new ScheduleMemoryAdapter();
  await a.add(fixture());
  await assert.rejects(a.add(fixture()), /already exists/);
});

test("list filters by kind", async () => {
  const a = new ScheduleMemoryAdapter();
  await a.add(fixture({ id: "a", kind: "signal" }));
  await a.add(fixture({ id: "b", kind: "broadcast-dynamic" }));
  const sigs = await a.list({ kind: "signal" });
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].id, "a");
});

test("list filters by enabled", async () => {
  const a = new ScheduleMemoryAdapter();
  await a.add(fixture({ id: "a", enabled: true }));
  await a.add(fixture({ id: "b", enabled: false }));
  const enabled = await a.list({ enabled: true });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].id, "a");
});

test("list filters by due (nextRunAt <= now AND enabled)", async () => {
  const a = new ScheduleMemoryAdapter();
  const past = new Date(Date.now() - 1000);
  const future = new Date(Date.now() + 60_000);
  await a.add(fixture({ id: "due", nextRunAt: past, enabled: true }));
  await a.add(fixture({ id: "future", nextRunAt: future, enabled: true }));
  await a.add(fixture({ id: "disabled", nextRunAt: past, enabled: false }));
  const due = await a.list({ due: true });
  assert.equal(due.length, 1);
  assert.equal(due[0].id, "due");
});

test("update applies a patch and bumps updatedAt", async () => {
  const a = new ScheduleMemoryAdapter();
  await a.add(fixture());
  const before = (await a.get("s1"))!.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  await a.update("s1", { interval: "10m" });
  const after = await a.get("s1");
  assert.equal(after?.interval, "10m");
  assert.ok(after!.updatedAt.getTime() > before.getTime());
});

test("update uses explicit undefined to clear optional fields", async () => {
  const a = new ScheduleMemoryAdapter();
  await a.add(fixture({ lastRunId: "run-123" }));
  await a.update("s1", { lastRunId: undefined as unknown as string });
  const after = await a.get("s1");
  assert.equal(after?.lastRunId, undefined);
});

test("claimDue returns true and advances when nextRunAt matches", async () => {
  const a = new ScheduleMemoryAdapter();
  const expected = new Date(Date.now() - 1000);
  const newNext = new Date(Date.now() + 60_000);
  await a.add(fixture({ nextRunAt: expected }));
  const ok = await a.claimDue("s1", expected, newNext);
  assert.equal(ok, true);
  const after = await a.get("s1");
  assert.equal(after?.nextRunAt.getTime(), newNext.getTime());
});

test("claimDue returns false when nextRunAt has changed (lost the race)", async () => {
  const a = new ScheduleMemoryAdapter();
  const expected = new Date(Date.now() - 1000);
  const otherWinner = new Date(Date.now() + 30_000);
  const ours = new Date(Date.now() + 60_000);
  await a.add(fixture({ nextRunAt: expected }));
  // Another runner already advanced it.
  await a.update("s1", { nextRunAt: otherWinner });
  const ok = await a.claimDue("s1", expected, ours);
  assert.equal(ok, false);
});

test("claimDue returns false when a schedule was disabled after listing", async () => {
  const a = new ScheduleMemoryAdapter();
  const expected = new Date(Date.now() - 1000);
  await a.add(fixture({ nextRunAt: expected }));
  await a.update("s1", { enabled: false });
  assert.equal(await a.claimDue("s1", expected, new Date(Date.now() + 60_000)), false);
});

test("delete removes the schedule", async () => {
  const a = new ScheduleMemoryAdapter();
  await a.add(fixture());
  assert.equal(await a.delete("s1"), true);
  assert.equal(await a.get("s1"), null);
  assert.equal(await a.delete("s1"), false);
});
