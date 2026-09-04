import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SignalRunner, MemoryAdapter } from "../src/index.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

// Ensure the child processes use tsx to import the .ts fixtures.
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));

/** Process-table inspection is how we prove a PID is really gone. */
const hasProc = existsSync("/proc/self/stat");

/**
 * PIDs of this process's direct children. `/proc/<pid>/stat` puts ppid in the
 * fourth field, but the second (`comm`) can itself contain spaces and parens,
 * so parse from the last `)` rather than splitting the whole line.
 */
function childPids(): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) === process.pid) pids.push(Number(entry));
    } catch {
      // Raced with the process exiting — which is exactly what we want anyway.
    }
  }
  return pids;
}

async function waitForSignal(runner: SignalRunner, name: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (runner.hasSignal(name)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`signal "${name}" was not discovered within ${timeoutMs}ms`);
}

/** Poll until no child PID outside `baseline` remains, or the deadline passes. */
async function waitForNoStrayChildren(baseline: Set<number>, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let stray: number[] = [];
  while (Date.now() < deadline) {
    stray = childPids().filter((pid) => !baseline.has(pid));
    if (stray.length === 0) return stray;
    await new Promise((r) => setTimeout(r, 50));
  }
  return stray;
}

/**
 * The regression that matters: a signal that completes but leaks a handle used
 * to leave its process resident forever. The parent dropped its only reference
 * to that child the moment the run resolved, so nothing could ever kill it.
 */
test(
  "a completed run that leaks a handle does not leave its process behind",
  { skip: hasProc ? false : "requires /proc" },
  async () => {
    const baseline = new Set(childPids());
    process.env.STATION_SIGNAL_DRAIN_MS = "500";
    const adapter = new MemoryAdapter();
    const runner = new SignalRunner({
      adapter,
      pollIntervalMs: 50,
      signalsDir: fixturesDir,
      reapGraceMs: 2_000,
      killGraceMs: 500,
    });
    const startP = runner.start();
    try {
      await waitForSignal(runner, "leaky-signal");
      const id = await runner.triggerSignal("leaky-signal", {});
      const run = await runner.waitForRun(id, { timeoutMs: 10_000 });
      assert.equal(run?.status, "completed");

      const stray = await waitForNoStrayChildren(baseline, 10_000);
      assert.deepEqual(stray, [], `leaked child processes: ${stray.join(", ")}`);
    } finally {
      delete process.env.STATION_SIGNAL_DRAIN_MS;
      await runner.stop();
      await startP;
    }
  },
);

/**
 * SIGTERM is not enough on its own: a handler can install its own listener and
 * swallow it. The runner must escalate to SIGKILL.
 */
test(
  "a child that disables its drain and swallows SIGTERM is still killed",
  { skip: hasProc ? false : "requires /proc" },
  async () => {
    const baseline = new Set(childPids());
    const adapter = new MemoryAdapter();
    const runner = new SignalRunner({
      adapter,
      pollIntervalMs: 50,
      signalsDir: fixturesDir,
      reapGraceMs: 1_000,
      killGraceMs: 500,
    });
    const startP = runner.start();
    try {
      await waitForSignal(runner, "stubborn-signal");
      const id = await runner.triggerSignal("stubborn-signal", {});
      const run = await runner.waitForRun(id, { timeoutMs: 10_000 });
      assert.equal(run?.status, "completed");

      const stray = await waitForNoStrayChildren(baseline, 10_000);
      assert.deepEqual(stray, [], `child survived SIGKILL escalation: ${stray.join(", ")}`);
    } finally {
      await runner.stop();
      await startP;
    }
  },
);
