import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAdapter } from "../src/adapters/memory.js";

test("memory atomic claims enforce immutable station placement across recovery", async () => {
  const adapter = new MemoryAdapter(); const now = new Date();
  await adapter.addRun({ id: "pinned", signalName: "work", kind: "trigger", input: "{}", status: "pending", attempts: 0, maxAttempts: 2, timeout: 1000, createdAt: now, requiredStationId: "a" });
  const claim = { claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 100), leaseToken: "first" };
  assert.equal(await adapter.claimRun("pinned", { ...claim, stationId: "b" }), null);
  assert.equal((await adapter.claimRun("pinned", { ...claim, stationId: "a" }))?.requiredStationId, "a");
  await adapter.updateRun("pinned", { requiredStationId: "b" } as never);
  await adapter.requeueExpiredRuns(new Date(now.getTime() + 101));
  assert.equal((await adapter.getRun("pinned"))?.requiredStationId, "a");
  assert.equal(await adapter.claimRun("pinned", { ...claim, stationId: "b" }), null);
  assert.equal((await adapter.claimRun("pinned", { ...claim, stationId: "a" }))?.attempts, 2);
});
