import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryAdapter, SignalRunner, signal, z, type Run } from "station-signal";
import { BroadcastRunner } from "../src/broadcast-runner.js";
import { BroadcastMemoryAdapter } from "../src/adapters/memory.js";
import type { BroadcastRun, BroadcastNodeRun } from "../src/types.js";

const plannerId = (id: string) => createHash("sha256").update(`station-planner:${id}`).digest("hex").slice(0, 32);
const plan = { nodes: [{ name: "first", signalName: "work", dependsOn: [] }] };
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 3000;
  do { const value = await read(); if (predicate(value)) return value; await new Promise(resolve=>setTimeout(resolve, 5)); } while (Date.now()<deadline);
  throw new Error(`Timed out: ${message}`);
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done=>{resolve=done;}); return { promise, resolve }; }
class CountingSignals extends MemoryAdapter {
  plannerAdds = 0;
  beforePlannerAdd?: () => Promise<void>;
  override async addRun(run: Run): Promise<void> {
    if (run.signalName.startsWith("planner-")) { this.plannerAdds++; await this.beforePlannerAdd?.(); }
    await super.addRun(run);
  }
}
function fixture(signalAdapter = new CountingSignals(), adapter = new BroadcastMemoryAdapter()) {
  const signals = new SignalRunner({ adapter: signalAdapter, maxConcurrent: 0 });
  for (const name of ["planner-v1", "planner-v2", "work-v1", "work-v2"]) signals.registerSignal(signal(name).input(z.unknown()).run(async input=>input), "/unused.ts");
  const failures: BroadcastRun[] = [];
  const runner = () => new BroadcastRunner({ signalRunner: signals, adapter, pollIntervalMs: 5, reconcileEveryNTicks: 0, subscribers: [{ onBroadcastFailed: event=>failures.push(structuredClone(event.broadcastRun)) }] });
  return { signals, signalAdapter, adapter, runner, failures };
}
async function complete(f: ReturnType<typeof fixture>, id: string, output: unknown) {
  await until(()=>f.signalAdapter.getRun(plannerId(id)), run=>!!run, "planner queued");
  await f.signalAdapter.updateRun(plannerId(id), { status: "completed", output: JSON.stringify(output), completedAt: new Date() });
}
async function stop(runner: BroadcastRunner, loop: Promise<void>) { await runner.stop(); await loop; }

test("planned broadcasts durably queue once, resume and pin planner/dependencies after registration changes", async () => {
  const f = fixture(); let runner = f.runner();
  runner.registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", { value: 42 }); let loop = runner.start();
  try {
    const planning = await until(()=>f.signalAdapter.getRun(plannerId(id)), run=>!!run, "planner queued");
    assert.equal(planning!.input, JSON.stringify({ value: 42 }));
    assert.equal(planning!.kind, "trigger");
    await new Promise(resolve=>setTimeout(resolve, 25));
    assert.equal(f.signalAdapter.plannerAdds, 1);
    assert.equal((await f.adapter.getBroadcastRun(id))!.status, "pending");
    assert.equal((await f.adapter.getNodeRuns(id)).length, 0);
    await stop(runner, loop);
    // A new controller changes current registration but must honor the old snapshot.
    runner = f.runner().registerPlanner("flow", { signalName: "planner-v2", dependencies: { work: "work-v2" } });
    loop = runner.start();
    await complete(f, id, plan);
    const nodes = await until(()=>f.adapter.getNodeRuns(id), nodes=>nodes.length===1&&nodes[0]!.status==="running", "planned child queued");
    const snapshot = (await f.adapter.getBroadcastRun(id))!.definitionSnapshot;
    assert.equal(nodes[0]!.signalName, "work-v1");
    assert.equal(JSON.parse(snapshot!).nodes[0].signalName, "work-v1");
    assert.equal(f.signalAdapter.plannerAdds, 1);
    await stop(runner, loop);
    // Resume from the persisted materialized DAG even if old planner output changes.
    await f.signalAdapter.updateRun(plannerId(id), { output: JSON.stringify({ nodes: [] }) });
    runner = f.runner().registerPlanner("flow", { signalName: "planner-v2", dependencies: { work: "work-v2" } });
    loop = runner.start();
    await f.signalAdapter.updateRun(nodes[0]!.signalRunId!, { status: "completed", output: JSON.stringify({ done: true }), completedAt: new Date() });
    await until(()=>f.adapter.getBroadcastRun(id), run=>run?.status==="completed", "broadcast completed");
    assert.equal((await f.adapter.getBroadcastRun(id))!.definitionSnapshot, snapshot);
    assert.equal(f.signalAdapter.plannerAdds, 1);
    assert.equal((await f.signalAdapter.listRuns("work-v2")).length, 0);
  } finally { await stop(runner, loop); }
});

test("invalid planner outputs fail before any child can be queued and emit current failure state", async () => {
  const f = fixture(), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const loop = runner.start();
  const cases = [
    null, { nodes: [] }, { nodes: [null] },
    { nodes: [plan.nodes[0], plan.nodes[0]] },
    { nodes: [{ ...plan.nodes[0], signalName: "work-v2" }] },
    { nodes: [{ ...plan.nodes[0], dependsOn: ["first"] }] },
    { nodes: [{ ...plan.nodes[0], dependsOn: "invalid" }] },
    { nodes: [{ ...plan.nodes[0], input: { kind: "ref", path: ["upstream", "other"] } }] },
    { ...plan, failurePolicy: "unknown" }, { ...plan, timeout: -1 },
    { ...plan, arbitrary: true },
  ];
  try {
    for (const output of cases) {
      const id = await runner.trigger("flow", {}); await complete(f, id, output);
      await until(()=>f.adapter.getBroadcastRun(id), run=>run?.status==="failed", "invalid plan failed");
      assert.deepEqual(await f.adapter.getNodeRuns(id), []);
      assert.equal(f.failures.at(-1)?.status, "failed");
      assert.ok(f.failures.at(-1)?.completedAt);
    }
    assert.equal((await f.signalAdapter.listRuns("work-v1")).length, 0);
  } finally { await stop(runner, loop); }
});

test("failed planner and missing immutable planner registration fail explicitly", async () => {
  const f = fixture(), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", {}), missing = await runner.trigger("flow", {});
  const snapshot = JSON.parse((await f.adapter.getBroadcastRun(missing))!.definitionSnapshot!); snapshot.signalName = "planner-missing";
  await f.adapter.updateBroadcastRun(missing, { definitionSnapshot: JSON.stringify(snapshot) });
  const loop = runner.start();
  try {
    await until(()=>f.signalAdapter.getRun(plannerId(id)), run=>!!run, "planner exists");
    await f.signalAdapter.updateRun(plannerId(id), { status: "failed", error: "planner failed", completedAt: new Date() });
    for (const runId of [id, missing]) {
      await until(()=>f.adapter.getBroadcastRun(runId), run=>run?.status==="failed", "planner failure propagated");
      assert.deepEqual(await f.adapter.getNodeRuns(runId), []);
    }
  } finally { await stop(runner, loop); }
});

test("cancellation racing initial planner persistence cancels the queued planner and cannot be overwritten", { timeout: 5000 }, async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  f.signalAdapter.beforePlannerAdd = async () => { entered.resolve(); await release.promise; };
  const runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", {}), loop = runner.start();
  try {
    await entered.promise;
    const cancelled = runner.cancel(id);
    release.resolve();
    assert.equal(await cancelled, true);
    assert.equal((await f.signalAdapter.getRun(plannerId(id)))!.status, "cancelled");
    await f.signalAdapter.updateRun(plannerId(id), { status: "completed", output: JSON.stringify(plan) });
    await new Promise(resolve=>setTimeout(resolve, 25));
    assert.equal((await f.adapter.getBroadcastRun(id))!.status, "cancelled");
    assert.deepEqual(await f.adapter.getNodeRuns(id), []);
    assert.equal(await runner.cancel(id), false);
  } finally { release.resolve(); await stop(runner, loop); }
});

test("malformed snapshots fail without blocking the queue and remain cancellable", async () => {
  const f = fixture(), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const bad = await runner.trigger("flow", {}), cancelled = await runner.trigger("flow", {}), good = await runner.trigger("flow", {});
  for (const id of [bad, cancelled]) await f.adapter.updateBroadcastRun(id, { definitionSnapshot: "{" });
  assert.equal(await runner.cancel(cancelled), true);
  const loop = runner.start();
  try {
    await until(()=>f.adapter.getBroadcastRun(bad), run=>run?.status==="failed", "malformed snapshot failed");
    await until(()=>f.signalAdapter.getRun(plannerId(good)), run=>!!run, "queue continued");
    assert.equal((await f.adapter.getBroadcastRun(cancelled))!.status, "cancelled");
  } finally { await stop(runner, loop); }
});

test("idempotent triggers keep the original planner snapshot and reject conflicting invocation identity", async () => {
  const f = fixture(), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const ids = await Promise.all(Array.from({ length: 8 }, () => runner.trigger("flow", { value: 1 }, { idempotencyKey: "beacon-event-1" })));
  assert.equal(new Set(ids).size, 1);
  const id = ids[0]!, snapshot = (await f.adapter.getBroadcastRun(id))!.definitionSnapshot;
  runner.registerPlanner("flow", { signalName: "planner-v2", dependencies: { work: "work-v2" } });
  assert.equal(await runner.trigger("flow", { value: 1 }, { idempotencyKey: "beacon-event-1" }), id);
  assert.equal((await f.adapter.getBroadcastRun(id))!.definitionSnapshot, snapshot);
  await assert.rejects(runner.trigger("flow", { value: 2 }, { idempotencyKey: "beacon-event-1" }), /conflicts/);
  await assert.rejects(runner.trigger("different", { value: 1 }, { idempotencyKey: "beacon-event-1" }), /conflicts/);
  assert.equal((await f.adapter.listBroadcastRuns("flow")).length, 1);
});

test("explicit Station placement survives planning, controller restart and child dispatch", async () => {
  const f = fixture();
  let runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const options = { idempotencyKey: "pinned-flow", requiredStationId: "worker-a" };
  const id = await runner.trigger("flow", {}, options);
  await assert.rejects(runner.trigger("flow", {}, { ...options, requiredStationId: "worker-b" }), /conflicts/);
  let loop = runner.start();
  try {
    const planner = await until(()=>f.signalAdapter.getRun(plannerId(id)), run=>!!run, "pinned planner queued");
    assert.equal(planner!.requiredStationId, "worker-a");
    await stop(runner, loop);
    runner = f.runner();
    loop = runner.start();
    await complete(f, id, plan);
    const nodes = await until(()=>f.adapter.getNodeRuns(id), nodes=>nodes.length===1&&!!nodes[0]!.signalRunId, "pinned child queued");
    assert.equal((await f.signalAdapter.getRun(nodes[0]!.signalRunId!))!.requiredStationId, "worker-a");
    assert.equal(JSON.parse((await f.adapter.getBroadcastRun(id))!.definitionSnapshot!).requiredStationId, "worker-a");
  } finally { await stop(runner, loop); }
});


test("partially persisted planned nodes recover without duplicate records or early completion", async () => {
  class InterruptedNodes extends BroadcastMemoryAdapter {
    writes = 0;
    interrupted = false;
    override async addNodeRun(node: BroadcastNodeRun) {
      this.writes++;
      await super.addNodeRun(node);
      if (!this.interrupted) { this.interrupted = true; throw new Error("simulated lost node persistence response"); }
    }
  }
  const adapter = new InterruptedNodes(), f = fixture(undefined, adapter);
  const runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", {}), loop = runner.start();
  try {
    await complete(f, id, { nodes: [plan.nodes[0], { name: "second", signalName: "work", dependsOn: ["first"] }] });
    const nodes = await until(()=>adapter.getNodeRuns(id), nodes=>nodes.length===2&&nodes[0]!.status==="running", "partial node initialization recovered");
    assert.equal(adapter.writes, 2);
    assert.equal((await adapter.getBroadcastRun(id))!.status, "running");
    assert.equal((await f.signalAdapter.listRuns("work-v1")).length, 1);
    const first = nodes.find(node=>node.nodeName==="first")!;
    await f.signalAdapter.updateRun(first.signalRunId!, { status: "completed", output: "{}", completedAt: new Date() });
    const ready = await until(()=>adapter.getNodeRuns(id), nodes=>nodes.some(n=>n.nodeName==="second"&&n.status==="running"), "dependent dispatched");
    const second = ready.find(node=>node.nodeName==="second")!;
    await f.signalAdapter.updateRun(second.signalRunId!, { status: "completed", output: "{}", completedAt: new Date() });
    await until(()=>adapter.getBroadcastRun(id), run=>run?.status==="completed", "recovered DAG completed");
    assert.equal(adapter.writes, 2);
    assert.equal(f.signalAdapter.plannerAdds, 1);
  } finally { await stop(runner, loop); }
});

test("cancelling a materialized plan cancels child work and late completions cannot revive it", async () => {
  const f = fixture(), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", {}), loop = runner.start();
  try {
    await complete(f, id, plan);
    const nodes = await until(()=>f.adapter.getNodeRuns(id), nodes=>nodes[0]?.status==="running", "child queued");
    assert.equal(await runner.cancel(id), true);
    assert.equal((await f.signalAdapter.getRun(nodes[0]!.signalRunId!))!.status, "cancelled");
    await f.signalAdapter.updateRun(nodes[0]!.signalRunId!, { status: "completed", output: "{}" });
    await new Promise(resolve=>setTimeout(resolve, 25));
    assert.equal((await f.adapter.getBroadcastRun(id))!.status, "cancelled");
    assert.equal((await f.adapter.getNodeRuns(id))[0]!.skipReason, "cancelled");
  } finally { await stop(runner, loop); }
});

test("lost child-state writes retry enqueue without creating another signal run", async () => {
  class LostChildState extends BroadcastMemoryAdapter {
    interrupted = false;
    override async updateNodeRun(id: string, patch: import("../src/types.js").BroadcastNodeRunPatch) {
      if (patch.status === "running" && !this.interrupted) { this.interrupted = true; throw new Error("simulated child-state transport failure"); }
      await super.updateNodeRun(id, patch);
    }
  }
  const f = fixture(undefined, new LostChildState()), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", {}), loop = runner.start();
  try {
    await complete(f, id, plan);
    const nodes = await until(()=>f.adapter.getNodeRuns(id), nodes=>nodes[0]?.status==="running", "child enqueue reconciled");
    const runs = await f.signalAdapter.listRuns("work-v1");
    assert.equal(runs.length, 1);
    assert.equal(nodes[0]!.signalRunId, runs[0]!.id);
    assert.equal(runs[0]!.idempotencyKey, `broadcast-node:${id}:first`);
    await runner.cancel(id);
  } finally { await stop(runner, loop); }
});

test("pending child intent remains cancellable after enqueue succeeds but node-state write fails", { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred();
  class LostChildState extends BroadcastMemoryAdapter {
    interrupted = false;
    override async updateNodeRun(id: string, patch: import("../src/types.js").BroadcastNodeRunPatch) {
      if (patch.status === "running" && !this.interrupted) {
        this.interrupted = true; entered.resolve(); await release.promise;
        throw new Error("simulated lost child-state write");
      }
      await super.updateNodeRun(id, patch);
    }
  }
  const f = fixture(undefined, new LostChildState()), runner = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const id = await runner.trigger("flow", {}), loop = runner.start();
  try {
    await complete(f, id, plan); await entered.promise;
    const cancelled = runner.cancel(id); release.resolve();
    assert.equal(await cancelled, true);
    assert.equal((await f.adapter.getBroadcastRun(id))!.status, "cancelled");
    const runs = await f.signalAdapter.listRuns("work-v1");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "cancelled");
  } finally { release.resolve(); await stop(runner, loop); }
});

test("concurrent controllers deduplicate the same broadcast key at the adapter boundary", async () => {
  const f = fixture();
  const first = f.runner().registerPlanner("flow", { signalName: "planner-v1", dependencies: { work: "work-v1" } });
  const second = f.runner().registerPlanner("flow", { signalName: "planner-v2", dependencies: { work: "work-v2" } });
  const ids = await Promise.all([first.trigger("flow", {}, { idempotencyKey: "shared-event" }), second.trigger("flow", {}, { idempotencyKey: "shared-event" })]);
  assert.equal(ids[0], ids[1]);
  assert.equal((await f.adapter.listBroadcastRuns("flow")).length, 1);
  const pinned = JSON.parse((await f.adapter.getBroadcastRun(ids[0]!))!.definitionSnapshot!);
  assert.equal(pinned.signalName, "planner-v1");
});
