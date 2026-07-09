import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SignalRunner, MemoryAdapter, type EnvProvider } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

// Ensure the child processes use tsx to import the .ts fixture.
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));

/** Discovery runs asynchronously inside start(); wait for the signal to land. */
async function waitForSignal(runner: SignalRunner, name: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner.hasSignal(name)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`signal "${name}" was not discovered within ${timeoutMs}ms`);
}

test("a run fails when a required env var is absent", async () => {
  // No env provider and TEST_ENV_VAR not in process.env → the run must fail
  // before a child is ever spawned.
  delete process.env.TEST_ENV_VAR;
  const adapter = new MemoryAdapter();
  const runner = new SignalRunner({ adapter, pollIntervalMs: 50, signalsDir: fixturesDir });
  const startP = runner.start();
  try {
    await waitForSignal(runner, "env-signal");
    const id = await runner.triggerSignal("env-signal", {});
    const run = await runner.waitForRun(id, { timeoutMs: 8000 });
    assert.equal(run?.status, "failed");
    assert.match(run?.error ?? "", /TEST_ENV_VAR/);
  } finally {
    await runner.stop();
    await startP;
  }
});

test("an injected env var satisfies the requirement and reaches the handler", async () => {
  delete process.env.TEST_ENV_VAR;
  const envProvider: EnvProvider = {
    async resolveFor(target) {
      assert.equal(target.kind, "signal");
      return { TEST_ENV_VAR: "injected-value" };
    },
  };
  const adapter = new MemoryAdapter();
  const runner = new SignalRunner({
    adapter,
    pollIntervalMs: 50,
    envProvider,
    signalsDir: fixturesDir,
  });
  const startP = runner.start();
  try {
    await waitForSignal(runner, "env-signal");
    const id = await runner.triggerSignal("env-signal", {});
    const run = await runner.waitForRun(id, { timeoutMs: 8000 });
    assert.equal(run?.status, "completed");
    assert.equal(JSON.parse(run?.output ?? "{}").seen, "injected-value");
  } finally {
    await runner.stop();
    await startP;
  }
});

test("a host process env var also satisfies the requirement", async () => {
  process.env.TEST_ENV_VAR = "from-host";
  const adapter = new MemoryAdapter();
  const runner = new SignalRunner({
    adapter,
    pollIntervalMs: 50,
    signalsDir: fixturesDir,
  });
  const startP = runner.start();
  try {
    await waitForSignal(runner, "env-signal");
    const id = await runner.triggerSignal("env-signal", {});
    const run = await runner.waitForRun(id, { timeoutMs: 8000 });
    assert.equal(run?.status, "completed");
    assert.equal(JSON.parse(run?.output ?? "{}").seen, "from-host");
  } finally {
    delete process.env.TEST_ENV_VAR;
    await runner.stop();
    await startP;
  }
});
