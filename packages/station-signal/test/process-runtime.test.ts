import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SignalRunner, NodeProcessRuntime, BunProcessRuntime, type ProcessSpawnOptions } from "../src/index.js";
import { runtimeSignal } from "./fixtures/runtime-signal.js";

const hasBun = spawnSync("bun", ["--version"]).status === 0;
const fixture = fileURLToPath(new URL("./fixtures/runtime-signal.ts", import.meta.url));

for (const runtime of [new NodeProcessRuntime(), new BunProcessRuntime()]) {
  test(`${runtime.name} executes real TypeScript signals over IPC, reports failure and cancels`, {
    skip: runtime.name === "bun" && !hasBun ? "optional Bun executable is not installed" : false,
    timeout: 20_000,
  }, async () => {
    const children: ReturnType<typeof runtime.spawn>[] = [];
    const runner = new SignalRunner({
      processRuntime: { name: runtime.name, spawn: (options) => {
        const child = runtime.spawn(options); children.push(child); return child;
      } },
      pollIntervalMs: 20,
      maxAttempts: 1,
      reapGraceMs: 100,
      killGraceMs: 100,
      envProvider: { resolveFor: async () => ({ RUNTIME_TEST_VALUE: "through-ipc" }) },
    });
    runner.registerSignal(runtimeSignal, fixture);
    const started = runner.start();
    try {
      const id = await runner.triggerSignal("runtime-signal", {});
      const run = await runner.waitForRun(id, { timeoutMs: 8_000 });
      assert.equal(run?.status, "completed", run?.error);
      assert.deepEqual(JSON.parse(run?.output ?? "null"), { runtime: runtime.name, value: "through-ipc" });
      const failed = await runner.triggerSignal("runtime-signal", { fail: true });
      const failure = await runner.waitForRun(failed, { timeoutMs: 8_000 });
      assert.equal(failure?.status, "failed");
      assert.match(failure?.error ?? "", /runtime fixture failure/);
      const cancel = await runner.triggerSignal("runtime-signal", { delayMs: 30_000 });
      const deadline = Date.now() + 5_000;
      while (children.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal(children.length, 3);
      assert.equal(await runner.cancel(cancel), true);
      assert.equal((await runner.getAdapter().getRun(cancel))?.status, "cancelled");
    } finally {
      await runner.stop();
      await started;
    }
    const deadline = Date.now() + 5_000;
    while (children.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(children.every((c) => c.exitCode !== null || c.signalCode !== null), "all runtime children reaped");
  });
}

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
test(`${processRuntime.name} launch failure settles the run without falling back to Node`, { timeout: 10_000 }, async () => {
  const runner = new SignalRunner({ processRuntime, maxAttempts: 1, pollIntervalMs: 20, reapGraceMs: 100, killGraceMs: 100 });
  runner.registerSignal(runtimeSignal, fixture);
  const started = runner.start();
  try {
    const id = await runner.triggerSignal("runtime-signal", {});
    assert.equal((await runner.waitForRun(id, { timeoutMs: 5_000 }))?.status, "failed");
  } finally { await runner.stop(); await started; }
});

test("failed IPC initialization reaps every spawned child", { timeout: 8_000 }, async () => {
  const deadline = Date.now() + 5_000;
  while (failedChildren.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(failedChildren.every((c) => c.exitCode !== null || c.signalCode !== null));
});
