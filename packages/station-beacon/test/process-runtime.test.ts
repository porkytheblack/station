import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BunProcessRuntime, NodeProcessRuntime, type ProcessSpawnOptions } from "station-signal";
import { BeaconRunner } from "../src/beacon-runner.js";
import { readyBeacon } from "./fixtures/ready-beacon.js";
import { quickBeacon } from "./fixtures/quick-beacon.js";
import { crashBeacon } from "./fixtures/crash-beacon.js";

const hasBun = spawnSync("bun", ["--version"]).status === 0;
const fx = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));

test("Bun supervises TypeScript beacons: ready IPC, crash restart and process cleanup", {
  skip: hasBun ? false : "optional Bun executable is not installed", timeout: 20_000,
}, async () => {
  const runtime = new BunProcessRuntime();
  const children: ReturnType<typeof runtime.spawn>[] = [];
  let ready = false;
  let restarted = false;
  const runner = new BeaconRunner({
    processRuntime: { name: "bun", spawn: (options) => {
      const child = runtime.spawn(options); children.push(child); return child;
    } },
    pollIntervalMs: 20,
    subscribers: [{
      onBeaconReady: ({ instance }) => { if (instance.beaconName === "ready-b") ready = true; },
      onBeaconRestartScheduled: ({ instance }) => { if (instance.beaconName === "crash-b") restarted = true; },
    }],
  });
  runner.register(readyBeacon, fx("ready-beacon"));
  runner.register(crashBeacon, fx("crash-beacon"));
  const started = runner.start();
  try {
    const deadline = Date.now() + 8_000;
    while ((!ready || !restarted) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ready, "Bun reports readiness through IPC");
    assert.ok(restarted, "Bun crash follows restart policy");
    assert.equal((await runner.getInstance("ready-b"))?.status, "running");
  } finally {
    await runner.stop({ graceful: true, timeoutMs: 2_000 });
    await started;
  }
  const deadline = Date.now() + 5_000;
  while (children.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(children.every((c) => c.exitCode !== null || c.signalCode !== null), "Bun beacon children reaped");
});

const failedChildren: ReturnType<NodeProcessRuntime["spawn"]>[] = [];
const brokenIPC = (asynchronous: boolean) => ({
  name: asynchronous ? "ipc-callback" : "ipc-throw",
  spawn(options: ProcessSpawnOptions) {
    const child = new NodeProcessRuntime().spawn(options);
    failedChildren.push(child);
    child.send = ((...args: unknown[]) => {
      const error = new Error("IPC init refused");
      if (!asynchronous) throw error;
      const callback = args[args.length - 1] as (error: Error) => void;
      setImmediate(() => callback(error));
      return false;
    }) as typeof child.send;
    return child;
  },
});
for (const processRuntime of [new BunProcessRuntime("/station-missing-bun"), { name: "throwing", spawn: (): never => { throw new Error("runtime refused launch"); } }, brokenIPC(false), brokenIPC(true)])
test(`${processRuntime.name} launch failure does not strand a beacon`, { timeout: 10_000 }, async () => {
  const runner = new BeaconRunner({ processRuntime, pollIntervalMs: 20 });
  runner.register(quickBeacon, fx("quick-beacon"));
  const started = runner.start();
  try {
    const deadline = Date.now() + 5_000;
    while ((await runner.getInstance("quick-b"))?.status !== "errored" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await runner.getInstance("quick-b"))?.status, "errored");
  } finally { await runner.stop(); await started; }
});

test("failed IPC initialization reaps every spawned child", { timeout: 8_000 }, async () => {
  const deadline = Date.now() + 5_000;
  while (failedChildren.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(failedChildren.every((c) => c.exitCode !== null || c.signalCode !== null));
});
