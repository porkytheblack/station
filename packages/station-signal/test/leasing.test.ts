import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter, type Run, type RunClaim } from "../src/index.js";

function pending(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    signalName: "work",
    kind: "trigger",
    input: "{}",
    status: "pending",
    attempts: 0,
    maxAttempts: 2,
    timeout: 30_000,
    createdAt: new Date(),
    ...over,
  };
}

function claim(stationId: string, token: string, at = new Date()): RunClaim {
  return { stationId, leaseToken: token, claimedAt: at, leaseExpiresAt: new Date(at.getTime() + 1_000) };
}

test("only one station can atomically claim a pending run", async () => {
  const adapter = new MemoryAdapter();
  await adapter.addRun(pending());
  const [a, b] = await Promise.all([
    adapter.claimRun!("run-1", claim("station-a", "token-a")),
    adapter.claimRun!("run-1", claim("station-b", "token-b")),
  ]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal((await adapter.getRun("run-1"))?.attempts, 1);
});

test("lease tokens fence stale completion and expired work is recovered", async () => {
  const adapter = new MemoryAdapter();
  const at = new Date(Date.now() - 5_000);
  await adapter.addRun(pending());
  await adapter.claimRun!("run-1", claim("station-a", "old-token", at));
  assert.equal(await adapter.requeueExpiredRuns!(new Date()), 1);

  const recovered = await adapter.claimRun!("run-1", claim("station-b", "new-token"));
  assert.equal(recovered?.stationId, "station-b");
  assert.equal(recovered?.attempts, 2);
  assert.equal(await adapter.updateClaimedRun!("run-1", "old-token", { status: "completed" }), false);
  assert.equal(await adapter.updateClaimedRun!("run-1", "new-token", { status: "completed" }), true);
});

test("cancelled attempts reject a late completion and duplicate ids are not overwritten", async () => {
  const adapter = new MemoryAdapter();
  await adapter.addRun(pending());
  await assert.rejects(() => adapter.addRun(pending({ status: "completed" })), /already exists/);
  const at = new Date();
  await adapter.claimRun!("run-1", claim("station-a", "token-a", at));
  assert.equal(await adapter.cancelRun!("run-1", new Date()), true);
  assert.equal(await adapter.updateClaimedRun!("run-1", "token-a", { status: "completed" }), false);
  assert.equal((await adapter.getRun("run-1"))?.status, "cancelled");
});

test("an expired lease cannot be renewed by its former owner", async () => {
  const adapter = new MemoryAdapter();
  const at = new Date(Date.now() - 5_000);
  await adapter.addRun(pending());
  await adapter.claimRun!("run-1", claim("station-a", "token-a", at));
  assert.equal(await adapter.renewRunLease!("run-1", "token-a", new Date(Date.now() + 5_000)), false);
});
