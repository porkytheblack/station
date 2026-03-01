import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SignalRunner, SignalQueueAdapter } from "station-signal";
import { parseInterval } from "station-signal";
import type { BroadcastDefinition } from "./broadcast.js";
import { configureBroadcast } from "./config.js";
import type { BroadcastQueueAdapter } from "./adapters/index.js";
import { BroadcastMemoryAdapter } from "./adapters/memory.js";
import type { BroadcastSubscriber } from "./subscribers/index.js";
import type {
  BroadcastRun,
  BroadcastNodeRun,
  FailurePolicy,
} from "./types.js";
import { isBroadcast } from "./util.js";

interface RecurringBroadcastSchedule {
  broadcastName: string;
  interval: string;
  nextRunAt: Date;
  input?: string;
  failurePolicy: FailurePolicy;
  timeout?: number;
}

export interface BroadcastRunnerOptions {
  signalRunner: SignalRunner;
  broadcastsDir?: string;
  adapter?: BroadcastQueueAdapter;
  pollIntervalMs?: number;
  subscribers?: BroadcastSubscriber[];
}

export class BroadcastRunner {
  private signalRunner: SignalRunner;
  private signalAdapter: SignalQueueAdapter;
  private adapter: BroadcastQueueAdapter;
  private broadcastsDir?: string;
  private pollIntervalMs: number;
  private subscribers: BroadcastSubscriber[];
  private registry = new Map<string, BroadcastDefinition>();
  private recurringSchedules = new Map<string, RecurringBroadcastSchedule>();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: BroadcastRunnerOptions) {
    this.signalRunner = options.signalRunner;
    this.signalAdapter = options.signalRunner.getAdapter();
    const adapter = options.adapter ?? new BroadcastMemoryAdapter();
    configureBroadcast({ adapter });
    this.adapter = adapter;
    this.broadcastsDir = options.broadcastsDir;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.subscribers = options.subscribers ? [...options.subscribers] : [];
  }

  /** List all registered broadcast definitions with metadata. */
  listRegistered(): Array<{ name: string; nodeCount: number; failurePolicy: FailurePolicy; timeout?: number; interval?: string }> {
    return Array.from(this.registry.values()).map((def) => ({
      name: def.name,
      nodeCount: def.nodes.length,
      failurePolicy: def.failurePolicy,
      timeout: def.timeout,
      interval: def.interval,
    }));
  }

  /** Check whether a broadcast is registered by name. */
  hasBroadcast(name: string): boolean {
    return this.registry.has(name);
  }

  /** Register a broadcast definition explicitly (alternative to auto-discovery). */
  register(definition: BroadcastDefinition): this {
    if (this.registry.has(definition.name)) {
      console.warn(
        `[station-broadcast] Duplicate broadcast name "${definition.name}" — overwriting.`,
      );
    }
    this.registry.set(definition.name, definition);
    if (definition.interval && !this.recurringSchedules.has(definition.name)) {
      this.scheduleRecurring(definition);
    }
    return this;
  }

  subscribe(subscriber: BroadcastSubscriber): this {
    this.subscribers.push(subscriber);
    return this;
  }

  async getBroadcastRun(id: string): Promise<BroadcastRun | null> {
    return this.adapter.getBroadcastRun(id);
  }

  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]> {
    return this.adapter.getNodeRuns(broadcastRunId);
  }

  async waitForBroadcastRun(
    id: string,
    opts?: { pollMs?: number; timeoutMs?: number },
  ): Promise<BroadcastRun | null> {
    const pollMs = opts?.pollMs ?? 200;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const run = await this.adapter.getBroadcastRun(id);
      if (!run) return null;
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        return run;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return this.adapter.getBroadcastRun(id);
  }

  async cancel(broadcastRunId: string): Promise<boolean> {
    const bRun = await this.adapter.getBroadcastRun(broadcastRunId);
    if (!bRun) return false;
    if (bRun.status === "completed" || bRun.status === "failed" || bRun.status === "cancelled") {
      return false;
    }

    // Cancel all running/pending nodes
    const nodeRuns = await this.adapter.getNodeRuns(broadcastRunId);
    for (const nr of nodeRuns) {
      if (nr.status === "running" && nr.signalRunId) {
        await this.signalRunner.cancel(nr.signalRunId);
      }
      if (nr.status === "pending" || nr.status === "running") {
        await this.adapter.updateNodeRun(nr.id, {
          status: "skipped",
          skipReason: "cancelled",
          completedAt: new Date(),
        });
      }
    }

    // H5: Mutate bRun before emitting so subscribers see current state
    bRun.status = "cancelled";
    bRun.completedAt = new Date();
    await this.adapter.updateBroadcastRun(broadcastRunId, {
      status: bRun.status,
      completedAt: bRun.completedAt,
    });
    this.emit("onBroadcastCancelled", { broadcastRun: bRun });
    return true;
  }

  /**
   * Trigger a broadcast by name. Prefer this over `definition.trigger()` as it
   * writes directly to this runner's adapter instead of the global singleton.
   */
  async trigger(broadcastName: string, input: unknown): Promise<string> {
    const definition = this.registry.get(broadcastName);
    if (!definition) {
      throw new Error(`No broadcast definition registered for "${broadcastName}"`);
    }
    const id = this.adapter.generateId();
    const bRun: BroadcastRun = {
      id,
      broadcastName,
      input: JSON.stringify(input),
      status: "pending",
      failurePolicy: definition.failurePolicy,
      timeout: definition.timeout,
      createdAt: new Date(),
    };
    await this.adapter.addBroadcastRun(bRun);
    this.emit("onBroadcastQueued", { broadcastRun: bRun });
    return id;
  }

  async start(): Promise<void> {
    if (this.broadcastsDir) {
      await this.discover(resolve(this.broadcastsDir));
    }

    const shutdown = () => {
      console.log("[station-broadcast] Received shutdown signal, stopping...");
      this.stop({ graceful: true, timeoutMs: 10_000 }).catch((err) => {
        console.error("[station-broadcast] Error during shutdown:", err);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[station-broadcast] tick() failed:", err);
      }
      await this.sleep(this.pollIntervalMs);
    }

    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  async stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    if (options?.graceful) {
      const timeout = options.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const running = await this.adapter.getBroadcastRunsRunning();
        if (running.length === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    await this.adapter.close?.();
  }

  private emit<K extends keyof BroadcastSubscriber>(
    event: K,
    data: Parameters<NonNullable<BroadcastSubscriber[K]>>[0],
  ): void {
    for (const sub of this.subscribers) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sub[event] as any)?.(data);
      } catch (err) {
        console.error(`[station-broadcast] Subscriber error in ${String(event)}:`, err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      this.pollTimer = setTimeout(res, ms);
    });
  }

  private async discover(dir: string): Promise<void> {
    let files: string[];
    try {
      const entries = await readdir(dir, { recursive: true });
      files = entries
        .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
        .map((f) => join(dir, f));
    } catch {
      console.error(`[station-broadcast] Cannot read broadcastsDir: ${dir}`);
      return;
    }

    for (const filePath of files) {
      try {
        const mod = await import(filePath);
        for (const value of Object.values(mod)) {
          if (isBroadcast(value)) {
            this.registry.set(value.name, value);
            this.emit("onBroadcastDiscovered", { broadcastName: value.name, filePath });
            if (value.interval && !this.recurringSchedules.has(value.name)) {
              this.scheduleRecurring(value);
            }
          }
        }
      } catch (err) {
        console.warn(`[station-broadcast] Skipping ${filePath} — failed to import (if .ts, ensure a TypeScript loader like tsx is active):`, err);
      }
    }
  }

  private scheduleRecurring(def: BroadcastDefinition): void {
    const ms = parseInterval(def.interval!);
    this.recurringSchedules.set(def.name, {
      broadcastName: def.name,
      interval: def.interval!,
      nextRunAt: new Date(Date.now() + ms),
      input: def.recurringInput ? JSON.stringify(def.recurringInput) : undefined,
      failurePolicy: def.failurePolicy,
      timeout: def.timeout,
    });
  }

  // ─── Tick ──────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    await this.tickRecurring();

    // Advance running broadcasts first
    const running = await this.adapter.getBroadcastRunsRunning();
    for (const bRun of running) {
      await this.advanceBroadcast(bRun);
    }

    // Pick up pending broadcasts
    const due = await this.adapter.getBroadcastRunsDue();
    for (const bRun of due) {
      await this.initBroadcast(bRun);
    }
  }

  private async tickRecurring(): Promise<void> {
    const now = new Date();
    for (const [name, schedule] of this.recurringSchedules) {
      if (schedule.nextRunAt > now) continue;

      const hasPendingOrRunning = await this.adapter.hasBroadcastRunWithStatus(
        name, ["pending", "running"],
      );
      if (hasPendingOrRunning) {
        const ms = parseInterval(schedule.interval);
        schedule.nextRunAt = new Date(Date.now() + ms);
        continue;
      }

      const id = this.adapter.generateId();
      const bRun: BroadcastRun = {
        id,
        broadcastName: name,
        input: schedule.input ?? JSON.stringify({}),
        status: "pending",
        failurePolicy: schedule.failurePolicy,
        timeout: schedule.timeout,
        createdAt: new Date(),
      };
      await this.adapter.addBroadcastRun(bRun);
      this.emit("onBroadcastQueued", { broadcastRun: bRun });

      const ms = parseInterval(schedule.interval);
      schedule.nextRunAt = new Date(Date.now() + ms);
    }
  }

  // ─── Init broadcast ────────────────────────────────────────────────

  private async initBroadcast(bRun: BroadcastRun): Promise<void> {
    // H4: Optimistic lock — re-read status to avoid double-init from concurrent ticks
    const fresh = await this.adapter.getBroadcastRun(bRun.id);
    if (!fresh || fresh.status !== "pending") return;

    const definition = this.registry.get(bRun.broadcastName);
    if (!definition) {
      const error = `No broadcast definition registered for "${bRun.broadcastName}"`;
      // H6: Mutate bRun before emitting so subscribers see current state
      bRun.status = "failed";
      bRun.completedAt = new Date();
      bRun.error = error;
      await this.adapter.updateBroadcastRun(bRun.id, {
        status: bRun.status,
        completedAt: bRun.completedAt,
        error,
      });
      this.emit("onBroadcastFailed", { broadcastRun: bRun, error });
      return;
    }

    // Mark as running
    bRun.status = "running";
    bRun.startedAt = new Date();
    await this.adapter.updateBroadcastRun(bRun.id, {
      status: bRun.status,
      startedAt: bRun.startedAt,
    });
    this.emit("onBroadcastStarted", { broadcastRun: bRun });

    // Create node run records for all nodes
    const nodeRunsByName = new Map<string, BroadcastNodeRun>();
    for (const node of definition.nodes) {
      const nodeRun: BroadcastNodeRun = {
        id: this.adapter.generateId(),
        broadcastRunId: bRun.id,
        nodeName: node.name,
        signalName: node.signalName,
        status: "pending",
      };
      await this.adapter.addNodeRun(nodeRun);
      nodeRunsByName.set(node.name, nodeRun);
    }

    // Trigger ready nodes (root nodes with no dependencies)
    await this.triggerReadyNodes(bRun, definition, nodeRunsByName);
  }

  // ─── Advance broadcast ─────────────────────────────────────────────

  private async advanceBroadcast(bRun: BroadcastRun): Promise<void> {
    const definition = this.registry.get(bRun.broadcastName);
    if (!definition) {
      await this.adapter.updateBroadcastRun(bRun.id, {
        status: "failed",
        completedAt: new Date(),
        error: `Definition for "${bRun.broadcastName}" not found`,
      });
      return;
    }

    // M8: Broadcast-level timeout check
    if (bRun.timeout && bRun.startedAt) {
      const elapsed = Date.now() - bRun.startedAt.getTime();
      if (elapsed > bRun.timeout) {
        await this.cancel(bRun.id);
        const error = `Broadcast timed out after ${bRun.timeout}ms`;
        bRun.status = "failed";
        bRun.completedAt = new Date();
        bRun.error = error;
        await this.adapter.updateBroadcastRun(bRun.id, {
          status: "failed",
          completedAt: bRun.completedAt,
          error,
        });
        this.emit("onBroadcastFailed", { broadcastRun: bRun, error });
        return;
      }
    }

    const nodeRuns = await this.adapter.getNodeRuns(bRun.id);
    const nodeRunsByName = new Map(nodeRuns.map((n) => [n.nodeName, n]));

    // Check running nodes for signal completion
    for (const nodeRun of nodeRuns) {
      if (nodeRun.status !== "running" || !nodeRun.signalRunId) continue;

      const signalRun = await this.signalAdapter.getRun(nodeRun.signalRunId);
      if (!signalRun) continue;

      if (signalRun.status === "completed") {
        await this.adapter.updateNodeRun(nodeRun.id, {
          status: "completed",
          output: signalRun.output,
          completedAt: new Date(),
        });
        nodeRun.status = "completed";
        nodeRun.output = signalRun.output;
        this.emit("onNodeCompleted", { broadcastRun: bRun, nodeRun });
      } else if (signalRun.status === "failed" || signalRun.status === "cancelled") {
        const error = signalRun.error ?? `Signal run ${signalRun.status}`;
        await this.adapter.updateNodeRun(nodeRun.id, {
          status: "failed",
          error,
          completedAt: new Date(),
        });
        nodeRun.status = "failed";
        nodeRun.error = error;
        this.emit("onNodeFailed", { broadcastRun: bRun, nodeRun, error });
      }
    }

    // H3: Only run failure handling when there are unresolved nodes to process
    const failedNodes = nodeRuns.filter((n) => n.status === "failed");
    const hasUnresolvedNodes = nodeRuns.some((n) => n.status === "pending" || n.status === "running");
    if (failedNodes.length > 0 && hasUnresolvedNodes) {
      const handled = await this.handleFailure(bRun, definition, nodeRunsByName, failedNodes);
      if (handled) return; // broadcast was terminated
    }

    // Trigger newly ready nodes
    await this.triggerReadyNodes(bRun, definition, nodeRunsByName);

    // Check if broadcast is complete
    const allTerminal = [...nodeRunsByName.values()].every(
      (n) => n.status === "completed" || n.status === "skipped" || n.status === "failed",
    );
    if (allTerminal) {
      const failedNames = [...nodeRunsByName.values()]
        .filter((n) => n.status === "failed")
        .map((n) => n.nodeName);
      const anyFailed = failedNames.length > 0;

      if (anyFailed && bRun.failurePolicy !== "continue") {
        const error = `Nodes failed: ${failedNames.join(", ")}`;
        bRun.status = "failed";
        bRun.completedAt = new Date();
        bRun.error = error;
        await this.adapter.updateBroadcastRun(bRun.id, {
          status: bRun.status,
          completedAt: bRun.completedAt,
          error,
        });
        this.emit("onBroadcastFailed", { broadcastRun: bRun, error });
      } else {
        // H2: For "continue" policy, still populate error so callers can detect partial failure
        bRun.status = "completed";
        bRun.completedAt = new Date();
        if (anyFailed) {
          bRun.error = `Completed with failures: ${failedNames.join(", ")}`;
        }
        await this.adapter.updateBroadcastRun(bRun.id, {
          status: bRun.status,
          completedAt: bRun.completedAt,
          error: bRun.error,
        });
        this.emit("onBroadcastCompleted", { broadcastRun: bRun });
      }
    }
  }

  // ─── Failure handling ──────────────────────────────────────────────

  /**
   * Apply the failure policy. Returns true if the broadcast was terminated
   * (fail-fast), false if processing should continue.
   */
  private async handleFailure(
    bRun: BroadcastRun,
    definition: BroadcastDefinition,
    nodeRunsByName: Map<string, BroadcastNodeRun>,
    failedNodes: BroadcastNodeRun[],
  ): Promise<boolean> {
    const policy = bRun.failurePolicy;

    if (policy === "fail-fast") {
      // Cancel all running signal runs and mark non-terminal nodes as skipped
      for (const nr of nodeRunsByName.values()) {
        if (nr.status === "running" && nr.signalRunId) {
          await this.signalRunner.cancel(nr.signalRunId);
        }
        if (nr.status === "pending" || nr.status === "running") {
          nr.status = "skipped";
          nr.skipReason = "cancelled";
          nr.completedAt = new Date();
          await this.adapter.updateNodeRun(nr.id, {
            status: "skipped",
            skipReason: "cancelled",
            completedAt: nr.completedAt,
          });
        }
      }

      const error = `Node "${failedNodes[0].nodeName}" failed (fail-fast)`;
      bRun.status = "failed";
      bRun.completedAt = new Date();
      bRun.error = error;
      await this.adapter.updateBroadcastRun(bRun.id, {
        status: bRun.status,
        completedAt: bRun.completedAt,
        error,
      });
      this.emit("onBroadcastFailed", { broadcastRun: bRun, error });
      return true;
    }

    if (policy === "skip-downstream" || policy === "continue") {
      // Skip downstream nodes whose upstreams have failed
      await this.skipDownstream(definition, nodeRunsByName, bRun);
      return false;
    }

    return false;
  }

  /**
   * Transitively skip pending nodes that have ANY upstream dependency that is
   * failed or was skipped due to an upstream failure (skipReason === "upstream-failed").
   * Guard-skipped nodes (skipReason === "guard") do NOT propagate failure downstream.
   */
  private async skipDownstream(
    definition: BroadcastDefinition,
    nodeRunsByName: Map<string, BroadcastNodeRun>,
    bRun: BroadcastRun,
  ): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of definition.nodes) {
        const nr = nodeRunsByName.get(node.name);
        if (!nr || nr.status !== "pending") continue;

        if (node.dependsOn.length > 0) {
          // H2: Skip when ANY dep is failed or failure-skipped (not ALL)
          const anyDepFailed = node.dependsOn.some((dep) => {
            const depRun = nodeRunsByName.get(dep);
            if (!depRun) return false;
            if (depRun.status === "failed") return true;
            // H3: Only propagate from upstream-failed skips, not guard skips
            return depRun.status === "skipped" && depRun.skipReason === "upstream-failed";
          });
          if (anyDepFailed) {
            // H1: Await adapter writes instead of fire-and-forget
            nr.status = "skipped";
            nr.skipReason = "upstream-failed";
            nr.completedAt = new Date();
            await this.adapter.updateNodeRun(nr.id, {
              status: "skipped",
              skipReason: "upstream-failed",
              completedAt: nr.completedAt,
            });
            this.emit("onNodeSkipped", {
              broadcastRun: bRun,
              nodeRun: nr,
              reason: "Upstream dependency failed",
            });
            changed = true;
          }
        }
      }
    }
  }

  // ─── Trigger ready nodes ───────────────────────────────────────────

  private async triggerReadyNodes(
    bRun: BroadcastRun,
    definition: BroadcastDefinition,
    nodeRunsByName: Map<string, BroadcastNodeRun>,
  ): Promise<void> {
    for (const node of definition.nodes) {
      const nodeRun = nodeRunsByName.get(node.name);
      if (!nodeRun || nodeRun.status !== "pending") continue;

      // H3: Dep is ready if completed OR guard-skipped. Failure-skipped deps are NOT ready
      // (those should have been handled by skipDownstream already).
      const depsReady = node.dependsOn.every((dep) => {
        const depRun = nodeRunsByName.get(dep);
        if (!depRun) return false;
        if (depRun.status === "completed") return true;
        if (depRun.status === "skipped" && depRun.skipReason === "guard") return true;
        return false;
      });
      if (!depsReady) continue;

      // Build upstream outputs map (always keyed by dep name, even for root)
      const upstreamOutputs: Record<string, unknown> = {};
      for (const dep of node.dependsOn) {
        const depRun = nodeRunsByName.get(dep)!;
        upstreamOutputs[dep] = depRun.output ? JSON.parse(depRun.output) : undefined;
      }

      // M10: when guard always receives upstreamOutputs (broadcast input for root nodes)
      const guardInput = node.dependsOn.length === 0
        ? JSON.parse(bRun.input)
        : upstreamOutputs;

      // Evaluate `when` guard — M1: wrap in try/catch
      if (node.when) {
        let guardResult: boolean;
        try {
          guardResult = node.when(guardInput);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          nodeRun.status = "failed";
          nodeRun.error = error;
          nodeRun.completedAt = new Date();
          await this.adapter.updateNodeRun(nodeRun.id, {
            status: "failed",
            error,
            completedAt: nodeRun.completedAt,
          });
          this.emit("onNodeFailed", { broadcastRun: bRun, nodeRun, error });
          continue;
        }
        if (!guardResult) {
          nodeRun.status = "skipped";
          nodeRun.skipReason = "guard";
          nodeRun.completedAt = new Date();
          await this.adapter.updateNodeRun(nodeRun.id, {
            status: "skipped",
            skipReason: "guard",
            completedAt: nodeRun.completedAt,
          });
          this.emit("onNodeSkipped", {
            broadcastRun: bRun,
            nodeRun,
            reason: "Guard \"when\" returned false",
          });
          continue;
        }
      }

      // Compute input for this node's signal — M1: wrap map in try/catch
      let nodeInput: unknown;
      if (node.dependsOn.length === 0) {
        nodeInput = JSON.parse(bRun.input);
      } else if (node.map) {
        try {
          nodeInput = node.map(upstreamOutputs);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          nodeRun.status = "failed";
          nodeRun.error = error;
          nodeRun.completedAt = new Date();
          await this.adapter.updateNodeRun(nodeRun.id, {
            status: "failed",
            error,
            completedAt: nodeRun.completedAt,
          });
          this.emit("onNodeFailed", { broadcastRun: bRun, nodeRun, error });
          continue;
        }
      } else if (node.dependsOn.length === 1) {
        nodeInput = upstreamOutputs[node.dependsOn[0]];
      } else {
        nodeInput = upstreamOutputs;
      }

      // H1: Use signal.trigger() for Zod input validation instead of writing directly
      let signalRunId: string;
      try {
        signalRunId = await node.signal.trigger(nodeInput);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        nodeRun.status = "failed";
        nodeRun.error = error;
        nodeRun.completedAt = new Date();
        await this.adapter.updateNodeRun(nodeRun.id, {
          status: "failed",
          error,
          completedAt: nodeRun.completedAt,
        });
        this.emit("onNodeFailed", { broadcastRun: bRun, nodeRun, error });
        continue;
      }

      // Update node run
      await this.adapter.updateNodeRun(nodeRun.id, {
        signalRunId,
        input: JSON.stringify(nodeInput),
        status: "running",
        startedAt: new Date(),
      });
      nodeRun.status = "running";
      nodeRun.signalRunId = signalRunId;
      nodeRun.input = JSON.stringify(nodeInput);

      this.emit("onNodeTriggered", { broadcastRun: bRun, nodeRun });
    }
  }
}
