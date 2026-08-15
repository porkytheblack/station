import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../src/index.js";
import type { Run } from "station-signal";

test("SQLite claims one owner and rejects a stale fencing token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-signal-lease-"));
  const adapter = new SqliteAdapter({ dbPath: join(dir, "station.db") });
  const now = new Date();
  const run: Run = {
    id: "run-1", signalName: "work", kind: "trigger", input: "{}", status: "pending",
    attempts: 0, maxAttempts: 2, timeout: 30_000, createdAt: now,
  };
  try {
    await adapter.addRun(run);
    const [a, b] = await Promise.all([
      adapter.claimRun("run-1", { stationId: "a", leaseToken: "ta", claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 1_000) }),
      adapter.claimRun("run-1", { stationId: "b", leaseToken: "tb", claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 1_000) }),
    ]);
    assert.equal([a, b].filter(Boolean).length, 1);
    const winner = a ? "ta" : "tb";
    const loser = a ? "tb" : "ta";
    assert.equal(await adapter.updateClaimedRun("run-1", loser, { status: "completed" }), false);
    assert.equal(await adapter.updateClaimedRun("run-1", winner, { status: "completed" }), true);
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQLite cancellation atomically wins against a late claimed completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-signal-cancel-"));
  const adapter = new SqliteAdapter({ dbPath: join(dir, "station.db") });
  try {
    const now = new Date();
    await adapter.addRun({
      id: "run-1", signalName: "work", kind: "trigger", input: "{}", status: "pending",
      attempts: 0, maxAttempts: 2, timeout: 30_000, createdAt: now,
    });
    const claimed = await adapter.claimRun("run-1", {
      stationId: "a", leaseToken: "token", claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + 10_000),
    });
    assert.ok(claimed);
    assert.equal(await adapter.cancelRun("run-1", new Date()), true);
    assert.equal(await adapter.updateClaimedRun("run-1", "token", { status: "completed" }), false);
    assert.equal((await adapter.getRun("run-1"))?.status, "cancelled");
  } finally {
    await adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
