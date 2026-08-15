import { test } from "node:test";
import assert from "node:assert/strict";
import { StationNetworkMemoryAdapter, type StationNode } from "../src/index.js";

function station(id: string, over: Partial<StationNode> = {}): StationNode {
  const now = new Date();
  return {
    id, networkId: "fleet", name: id, role: "station", status: "online", labels: {},
    capacity: { maxConcurrent: 4, activeRuns: 0 },
    definitions: { signals: ["work"], broadcasts: [], beacons: [] },
    startedAt: now, lastHeartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + 1_000),
    ...over,
  };
}

test("membership heartbeats preserve network inventory and mark expired nodes offline", async () => {
  const adapter = new StationNetworkMemoryAdapter();
  await adapter.upsertStation(station("a", { leaseExpiresAt: new Date(Date.now() - 1) }));
  await adapter.upsertStation(station("b", { networkId: "other" }));
  assert.equal((await adapter.listStations({ networkId: "fleet" })).length, 1);
  assert.equal(await adapter.markOfflineBefore(new Date(), "fleet"), 1);
  assert.equal((await adapter.getStation("a"))?.status, "offline");
});

test("membership snapshots preserve rich beacon metadata", async () => {
  const adapter = new StationNetworkMemoryAdapter();
  const now = new Date();
  const member = station("station-a", { lastHeartbeatAt: now });
  member.definitions.beacons = ["gateway"];
  member.definitions.beaconMetadata = [{
    name: "gateway",
    mode: "run",
    restartPolicy: "on-failure",
    startMode: "manual",
    autoStart: false,
    maxInstances: 2,
    requiredEnv: ["ORIGIN"],
  }];

  await adapter.upsertStation(member);
  const first = await adapter.getStation(member.id);
  assert.deepEqual(first?.definitions.beaconMetadata, member.definitions.beaconMetadata);

  const metadata = [{ ...member.definitions.beaconMetadata[0]!, maxInstances: 3 }];
  await adapter.heartbeat(member.id, {
    status: "online",
    capacity: member.capacity,
    definitions: { ...member.definitions, beaconMetadata: metadata },
    lastHeartbeatAt: now,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
  });
  assert.deepEqual((await adapter.getStation(member.id))?.definitions.beaconMetadata, metadata);
});

test("controller leases are exclusive, renewable, fenced, and recover after expiry", async () => {
  const adapter = new StationNetworkMemoryAdapter();
  const now = new Date();
  assert.equal(await adapter.acquireControllerLease({ name: "beacon:x", holderId: "a", token: "ta", expiresAt: new Date(now.getTime() + 100) }, now), true);
  assert.equal(await adapter.acquireControllerLease({ name: "beacon:x", holderId: "b", token: "tb", expiresAt: new Date(now.getTime() + 100) }, now), false);
  assert.equal(await adapter.renewControllerLease("beacon:x", "a", "wrong", new Date(now.getTime() + 200)), false);
  assert.equal(await adapter.renewControllerLease(
    "beacon:x", "a", "ta", new Date(now.getTime() + 300), new Date(now.getTime() + 101),
  ), false);
  assert.equal(await adapter.acquireControllerLease({ name: "beacon:x", holderId: "b", token: "tb", expiresAt: new Date(now.getTime() + 300) }, new Date(now.getTime() + 101)), true);
  assert.equal(await adapter.releaseControllerLease("beacon:x", "a", "ta"), false);
  assert.equal((await adapter.getControllerLease("beacon:x"))?.holderId, "b");
});
