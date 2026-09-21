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

test("SQLite placement survives competing claims, expired lease recovery and immutable patches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-signal-pin-"));
  const path = join(dir, "station.db"), adapter = new SqliteAdapter({ dbPath: path }), other = new SqliteAdapter({ dbPath: path });
  try {
    const now = new Date();
    await adapter.addRun({ id: "pinned", signalName: "work", kind: "trigger", input: "{}", status: "pending", attempts: 0, maxAttempts: 3, timeout: 30_000, createdAt: now, requiredStationId: "a" });
    assert.equal((await other.getRun("pinned"))?.requiredStationId, "a");
    const claim = { leaseToken: "owner-a", claimedAt: now, leaseExpiresAt: new Date(now.getTime() + 1000) };
    assert.equal(await other.claimRun("pinned", { ...claim, stationId: "b" }), null);
    assert.equal((await adapter.claimRun("pinned", { ...claim, stationId: "a" }))?.stationId, "a");
    await other.updateRun("pinned", { requiredStationId: "b" } as never);
    assert.equal((await other.getRun("pinned"))?.requiredStationId, "a");
    const later = new Date(now.getTime() + 1500);
    assert.equal(await other.requeueExpiredRuns(later), 1);
    assert.equal((await other.getRun("pinned"))?.requiredStationId, "a");
    assert.equal((await other.getRun("pinned"))?.status, "pending");
    const retry = { leaseToken: "retry", claimedAt: later, leaseExpiresAt: new Date(later.getTime() + 1000) };
    assert.equal(await other.claimRun("pinned", { ...retry, stationId: "b" }), null);
    assert.equal((await adapter.claimRun("pinned", { ...retry, stationId: "a" }))?.attempts, 2);
  } finally { await adapter.close(); await other.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("two real SQLite workers leave an offline target pending and execute both retry attempts only on that target", { timeout: 15_000 }, async () => {
  const { writeFile } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { SignalRunner, signal, z } = await import("station-signal");
  const dir = mkdtempSync(join(tmpdir(), "station-worker-pin-")); const path = join(dir, "station.db");
  const a = new SqliteAdapter({ dbPath: path }), b = new SqliteAdapter({ dbPath: path });
  const entry = join(dir, "work.mjs"), signalURL = pathToFileURL(createRequire(import.meta.url).resolve("station-signal")).href;
  await writeFile(entry, `import{signal,z,getRunContext}from ${JSON.stringify(signalURL)};export const work=signal('pinned-work').input(z.object({})).output(z.unknown()).retries(1).run(async()=>{const c=getRunContext();if(c.attempt===1)throw new Error('retry once');return {attempt:c.attempt,runId:c.runId}});`);
  const definition = signal("pinned-work").input(z.object({})).output(z.unknown()).retries(1).run(async () => null);
  const owners: string[] = [];
  const runnerA = new SignalRunner({ stationId: "a", adapter: a, pollIntervalMs: 20, retryBackoffMs: 20, subscribers: [{ onRunDispatched: () => { owners.push("a"); } }] });
  const runnerB = new SignalRunner({ stationId: "b", adapter: b, pollIntervalMs: 20, retryBackoffMs: 20, subscribers: [{ onRunDispatched: () => { owners.push("b"); } }] });
  runnerA.registerSignal(definition, entry); runnerB.registerSignal(definition, entry);
  const runningB = runnerB.start(); let runningA: Promise<void> | undefined;
  try {
    const id = await runnerA.triggerSignal("pinned-work", {}, undefined, { requiredStationId: "a", idempotencyKey: "pinned-once" });
    await assert.rejects(runnerA.triggerSignal("pinned-work", {}, undefined, { requiredStationId: "b", idempotencyKey: "pinned-once" }), /conflicts/);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await b.getRun(id))?.status, "pending"); assert.deepEqual(owners, []);
    runningA = runnerA.start();
    const run = await runnerA.waitForRun(id, { timeoutMs: 10_000 });
    assert.equal(run?.status, "completed", run?.error); assert.equal(run?.requiredStationId, "a"); assert.equal(run?.attempts, 2);
    assert.deepEqual(owners, ["a", "a"]); assert.deepEqual(JSON.parse(run?.output ?? "null"), { attempt: 2, runId: id });
  } finally { await runnerA.stop(); await runnerB.stop(); await runningA; await runningB; await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true }); }
});
