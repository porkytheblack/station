import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StationNetworkSqliteAdapter } from "../src/network.js";
import type { StationNode } from "station-network";

function fixture(id: string): StationNode {
  const now = new Date();
  return {
    id, networkId: "fleet", name: id, role: "station", status: "online",
    labels: { region: "ke" }, capacity: { maxConcurrent: 4, activeRuns: 1 },
    definitions: { signals: ["work"], broadcasts: [], beacons: ["web"] },
    endpoint: "http://station.local", startedAt: now, lastHeartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + 1_000),
  };
}

test("SQLite network adapter persists membership and atomically fences controller leases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-network-"));
  const adapter = new StationNetworkSqliteAdapter({ dbPath: join(dir, "station.db") });
  try {
    await adapter.upsertStation(fixture("a"));
    const got = await adapter.getStation("a");
    assert.deepEqual(got?.labels, { region: "ke" });
    assert.deepEqual(got?.definitions.beacons, ["web"]);

    const now = new Date();
    assert.equal(await adapter.acquireControllerLease({ name: "beacon:web", holderId: "a", token: "ta", expiresAt: new Date(now.getTime() + 100) }, now), true);
    assert.equal(await adapter.acquireControllerLease({ name: "beacon:web", holderId: "b", token: "tb", expiresAt: new Date(now.getTime() + 100) }, now), false);
    assert.equal(await adapter.acquireControllerLease({ name: "beacon:web", holderId: "b", token: "tb", expiresAt: new Date(now.getTime() + 300) }, new Date(now.getTime() + 101)), true);
    assert.equal((await adapter.getControllerLease("beacon:web"))?.holderId, "b");
  } finally {
    await adapter.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
