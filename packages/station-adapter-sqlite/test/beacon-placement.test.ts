import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BeaconRunner } from "../../station-beacon/src/beacon-runner.js";
import { workerBeacon } from "../../station-beacon/test/fixtures/worker-beacon.js";
import { BeaconSqliteAdapter } from "../src/beacon.js";
import { StationNetworkSqliteAdapter } from "../src/network.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>, label: string) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}

test("beacon station pin survives restart and owner recovery without foreign takeover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-beacon-placement-"));
  const dbPath = join(dir, "state.db");
  const observer = new BeaconSqliteAdapter({ dbPath });
  const networks: StationNetworkSqliteAdapter[] = [];
  const runners: BeaconRunner[] = [];
  const owners: string[] = [];
  function makeRunner(stationId: string) {
    const network = new StationNetworkSqliteAdapter({ dbPath });
    networks.push(network);
    const runner = new BeaconRunner({
      adapter: new BeaconSqliteAdapter({ dbPath }), networkCoordinator: network,
      stationId, networkId: "pinned-test", pollIntervalMs: 20, leaseDurationMs: 150,
      subscribers: [{ onBeaconStarting: ({ instance }) => {
        if (instance.id === "pinned") owners.push(stationId);
      } }],
    });
    runner.register(workerBeacon, fileURLToPath(new URL("../../station-beacon/test/fixtures/worker-beacon.ts", import.meta.url)));
    runners.push(runner);
    return runner;
  }
  const foreign = makeRunner("worker-b");
  let owner = makeRunner("worker-a");
  try {
    foreign.start().catch(() => {});
    await foreign.whenReady();
    await foreign.createInstance("worker-b", { id: "pinned", config: { queue: "jobs" }, requiredStationId: "worker-a" });
    await observer.updateInstance("pinned", { requiredStationId: "worker-b" } as any);
    assert.equal((await observer.getInstance("pinned"))?.requiredStationId, "worker-a");
    await sleep(120);
    assert.deepEqual(owners, []);
    assert.equal((await observer.getInstance("pinned"))?.incarnation, 0);

    owner.start().catch(() => {});
    await owner.whenReady();
    await until(async () => Boolean((await observer.getInstance("pinned"))?.readyAt), "first ready");
    await owner.restartInstance("pinned");
    await until(async () => {
      const instance = await observer.getInstance("pinned");
      return instance?.incarnation === 2 && Boolean(instance.readyAt);
    }, "restart on owner");
    await owner.stop({ graceful: true, timeoutMs: 2000 });
    await sleep(250); // Foreign worker has multiple opportunities after lease expiry.
    assert.deepEqual(owners, ["worker-a", "worker-a"]);
    assert.equal((await observer.getInstance("pinned"))?.requiredStationId, "worker-a");

    owner = makeRunner("worker-a");
    owner.start().catch(() => {});
    await owner.whenReady();
    await until(async () => {
      const instance = await observer.getInstance("pinned");
      return instance?.incarnation === 3 && Boolean(instance.readyAt);
    }, "recovered owner");
    assert.deepEqual(owners, ["worker-a", "worker-a", "worker-a"]);
    assert.equal((await observer.getInstance("pinned"))?.stationId, "worker-a");
  } finally {
    for (const runner of runners) await runner.stop({ graceful: true, timeoutMs: 2000 });
    for (const network of networks) await network.close();
    await observer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
