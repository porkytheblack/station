import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AnySignal, SignalRunner, SignalQueueAdapter } from "station-signal";
import { parseInterval } from "station-signal";
import type { BroadcastDefinition } from "./broadcast.js";
import { configureBroadcast } from "./config.js";
import type { BroadcastQueueAdapter } from "./adapters/index.js";
import { BroadcastMemoryAdapter } from "./adapters/memory.js";
import type { BroadcastSubscriber } from "./subscribers/index.js";
import type {
  BroadcastRun,
  BroadcastNodeRun,
  DynamicBroadcastSpec,
  FailurePolicy,
} from "./types.js";
import { isBroadcast, topologicalSort } from "./util.js";
import { materializeDynamic, type MaterializedDynamicBroadcast } from "./dynamic.js";

interface RecurringBroadcastSchedule {
  broadcastName: string;
  interval: string;
  nextRunAt: Date;
  input?: string;
  failurePolicy: FailurePolicy;
  timeout?: number;
}

/** Minimal interface a schedule reconciler needs from the runner. */
export interface BroadcastScheduleReconciler {
  tick(): Promise<void>;
}

export interface BroadcastRunnerOptions {
  signalRunner: SignalRunner;
  broadcastsDir?: string;
  adapter?: BroadcastQueueAdapter;
  pollIntervalMs?: number;
  subscribers?: BroadcastSubscriber[];
  /**
   * How often (in poll ticks) to refresh the dynamic broadcast registry from
   * the adapter. Default: 5. Set to 0 to disable reconciliation.
   */
  reconcileEveryNTicks?: number;
  /**
   * Optional dynamic schedule reconciler. When set, the runner ticks it on
   * the same cadence as broadcast discovery. Wire `station-schedules` here.
   */
  scheduleReconciler?: BroadcastScheduleReconciler;
}

export class BroadcastRunner {
  private signalRunner: SignalRunner;
  private signalAdapter: SignalQueueAdapter;
  private adapter: BroadcastQueueAdapter;
  private broadcastsDir?: string;
  private pollIntervalMs: number;
  private subscribers: BroadcastSubscriber[];
  /** File-defined broadcasts (immutable, discovered at startup). */
  private fileRegistry = new Map<string, BroadcastDefinition>();
  /**
   * Dynamic broadcasts (loaded from the adapter, refreshed on a cadence).
   * Lives in a separate namespace so names can collide harmlessly.
   */
  private dynamicRegistry = new Map<string, MaterializedDynamicBroadcast>();
  private signalRegistry = new Map<string, AnySignal>();
  /**
   * Materialized definitions for snapshot-backed runs, keyed by broadcast run
   * id. Snapshots are immutable per run, so the materialization (including its
   * topological sort) only needs to happen once. Entries are cleared when the
   * run reaches a terminal state.
   */
  private snapshotDefinitionCache = new Map<string, BroadcastDefinition>();
  private recurringSchedules = new Map<string, RecurringBroadcastSchedule>();
  private reconcileEveryNTicks: number;
  private scheduleReconciler?: BroadcastScheduleReconciler;
  private tickCount = 0;
  private running = false;
  private stopping = false;
  private ticking = false;
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
    this.reconcileEveryNTicks = options.reconcileEveryNTicks ?? 5;
    this.scheduleReconciler = options.scheduleReconciler;

    // Pre-populate signal registry from the SignalRunner so dynamic broadcasts
    // can resolve signal names. This is a snapshot; refreshed at registration time.
    this.refreshSignalRegistry();
  }

  /**
   * List all registered broadcast definitions with metadata. Includes both
   * file-defined and dynamic broadcasts; the `kind` field disambiguates.
   */
  listRegistered(): Array<{
    name: string;
    kind: "file" | "dynamic";
    nodeCount: number;
    failurePolicy: FailurePolicy;
    timeout?: number;
    interval?: string;
    version?: number;
  }> {
    const out: Array<{
      name: string;
      kind: "file" | "dynamic";
      nodeCount: number;
      failurePolicy: FailurePolicy;
      timeout?: number;
      interval?: string;
      version?: number;
    }> = [];
    for (const def of this.fileRegistry.values()) {
      out.push({
        name: def.name,
        kind: "file",
        nodeCount: def.nodes.length,
        failurePolicy: def.failurePolicy,
        timeout: def.timeout,
        interval: def.interval,
      });
    }
    for (const entry of this.dynamicRegistry.values()) {
      out.push({
        name: entry.spec.name,
        kind: "dynamic",
        nodeCount: entry.spec.nodes.length,
        failurePolicy: entry.spec.failurePolicy,
        timeout: entry.spec.timeout,
        version: entry.spec.version,
      });
    }
    return out;
  }

  /** Check whether a broadcast is registered (file OR dynamic) by name. */
  hasBroadcast(name: string): boolean {
    return this.fileRegistry.has(name) || this.dynamicRegistry.has(name);
  }

  /** Whether a dynamic broadcast with this name is currently registered. */
  hasDynamicBroadcast(name: string): boolean {
    return this.dynamicRegistry.has(name);
  }

  /** Register a broadcast definition explicitly (alternative to auto-discovery). */
  register(definition: BroadcastDefinition): this {
    if (this.fileRegistry.has(definition.name)) {
      console.warn(
        `[station-broadcast] Duplicate broadcast name "${definition.name}" — overwriting.`,
      );
    }
    this.fileRegistry.set(definition.name, definition);
    // Cache referenced signals so dynamic broadcasts can use them too.
    for (const node of definition.nodes) {
      if (!this.signalRegistry.has(node.signalName)) {
        this.signalRegistry.set(node.signalName, node.signal);
      }
    }
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
    this.snapshotDefinitionCache.delete(broadcastRunId);
    this.emit("onBroadcastCancelled", { broadcastRun: bRun });
    return true;
  }

  /**
   * Trigger a broadcast by name. Resolves to the file-defined registry first,
   * then falls back to dynamic broadcasts. For dynamic broadcasts, the current
   * spec is snapshotted into the run record so spec edits don't mutate the run.
   */
  async trigger(broadcastName: string, input: unknown): Promise<string> {
    const fileDef = this.fileRegistry.get(broadcastName);
    if (fileDef) {
      const id = this.adapter.generateId();
      const bRun: BroadcastRun = {
        id,
        broadcastName,
        input: JSON.stringify(input),
        status: "pending",
        failurePolicy: fileDef.failurePolicy,
        timeout: fileDef.timeout,
        createdAt: new Date(),
      };
      await this.adapter.addBroadcastRun(bRun);
      this.emit("onBroadcastQueued", { broadcastRun: bRun });
      return id;
    }

    const dynamic = this.dynamicRegistry.get(broadcastName);
    if (dynamic) {
      return this.triggerDynamic(broadcastName, input);
    }

    throw new Error(`No broadcast definition registered for "${broadcastName}"`);
  }

  /** Trigger a dynamic broadcast and snapshot its current spec into the run. */
  async triggerDynamic(name: string, input: unknown): Promise<string> {
    const entry = this.dynamicRegistry.get(name);
    if (!entry) {
      throw new Error(`No dynamic broadcast registered for "${name}"`);
    }
    const id = this.adapter.generateId();
    const bRun: BroadcastRun = {
      id,
      broadcastName: name,
      input: JSON.stringify(input),
      status: "pending",
      failurePolicy: entry.spec.failurePolicy,
      timeout: entry.spec.timeout,
      createdAt: new Date(),
      definitionSnapshot: JSON.stringify(entry.spec),
    };
    await this.adapter.addBroadcastRun(bRun);
    this.emit("onBroadcastQueued", { broadcastRun: bRun });
    return id;
  }

  /**
   * Tracks specs that failed to materialize so each tick can retry them when
   * the signal registry changes. Without this, a temporarily missing signal
   * would wedge a broadcast permanently — even after the signal returns —
   * because the spec's version wouldn't change.
   */
  private failedMaterializations = new Map<string, DynamicBroadcastSpec>();
  private lastSignalRegistrySize = 0;

  /** Force a refresh of the dynamic broadcast registry from the adapter. */
  async reconcileDynamicDefinitions(): Promise<void> {
    if (!this.adapter.listDefinitions) return;
    let specs: DynamicBroadcastSpec[];
    try {
      specs = await this.adapter.listDefinitions();
    } catch (err) {
      console.error("[station-broadcast] Failed to list dynamic definitions:", err);
      return;
    }

    this.refreshSignalRegistry();
    const signalsChanged = this.signalRegistry.size !== this.lastSignalRegistrySize;
    this.lastSignalRegistrySize = this.signalRegistry.size;

    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.name);
      const existing = this.dynamicRegistry.get(spec.name);
      const previouslyFailed = this.failedMaterializations.has(spec.name);
      // Skip if we already have this exact version and it's not a previous
      // failure waiting on a signal-registry change.
      if (existing && existing.spec.version === spec.version && !previouslyFailed) continue;
      // If the same failed version is still in play, only retry when signals
      // have changed — otherwise we'd log every tick.
      if (
        previouslyFailed &&
        this.failedMaterializations.get(spec.name)?.version === spec.version &&
        !signalsChanged
      ) continue;

      try {
        const materialized = materializeDynamic(spec, this.signalRegistry);
        this.dynamicRegistry.set(spec.name, materialized);
        this.failedMaterializations.delete(spec.name);
      } catch (err) {
        this.failedMaterializations.set(spec.name, spec);
        console.warn(
          `[station-broadcast] Skipping dynamic broadcast "${spec.name}" v${spec.version}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Drop registrations that no longer exist (deleted or filtered out).
    for (const name of [...this.dynamicRegistry.keys()]) {
      if (!seen.has(name)) this.dynamicRegistry.delete(name);
    }
    for (const name of [...this.failedMaterializations.keys()]) {
      if (!seen.has(name)) this.failedMaterializations.delete(name);
    }
  }

  private refreshSignalRegistry(): void {
    for (const [name, sig] of this.signalRunner.getAllSignals()) {
      this.signalRegistry.set(name, sig);
    }
  }

  /**
   * Whether any pending or running BroadcastRun exists for `broadcastName`.
   * Used by the schedule reconciler to skip overlapping fires.
   */
  hasPendingOrRunningForBroadcast(broadcastName: string): Promise<boolean> {
    return this.adapter.hasBroadcastRunWithStatus(broadcastName, ["pending", "running"]);
  }

  /**
   * Resolve the BroadcastDefinition to use for a run. For runs with a
   * `definitionSnapshot`, the snapshot is materialized fresh so spec edits
   * after trigger time don't affect this run. Otherwise the file registry is
   * consulted, then the live dynamic registry as a fallback.
   */
  private resolveDefinitionForRun(bRun: BroadcastRun): BroadcastDefinition | null {
    if (bRun.definitionSnapshot) {
      const cached = this.snapshotDefinitionCache.get(bRun.id);
      if (cached) return cached;
      try {
        const spec = JSON.parse(bRun.definitionSnapshot) as DynamicBroadcastSpec;
        const definition = materializeDynamic(spec, this.signalRegistry).definition;
        this.snapshotDefinitionCache.set(bRun.id, definition);
        return definition;
      } catch (err) {
        console.error(
          `[station-broadcast] Failed to materialize snapshot for run ${bRun.id}:`,
          err,
        );
        return null;
      }
    }
    const fileDef = this.fileRegistry.get(bRun.broadcastName);
    if (fileDef) return fileDef;
    const dynamic = this.dynamicRegistry.get(bRun.broadcastName);
    return dynamic ? dynamic.definition : null;
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("[station-broadcast] Runner is already started");
    }

    if (this.broadcastsDir) {
      await this.discover(resolve(this.broadcastsDir));
    }

    // Initial reconciliation so dynamic broadcasts are available before the
    // first tick (otherwise pending dynamic runs would fail their first init).
    await this.reconcileDynamicDefinitions();

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
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.snapshotDefinitionCache.clear();

    if (options?.graceful) {
      const timeout = options.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const running = await this.adapter.getBroadcastRunsRunning();
        if (running.length === 0) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    try {
      await this.adapter.close?.();
    } catch (err) {
      console.error("[station-broadcast] Error closing adapter:", err);
    }
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
        .filter((f) => {
          if (!(f.endsWith(".ts") || f.endsWith(".js")) || f.endsWith(".d.ts")) return false;
          // Never import from node_modules or hidden files/directories.
          const segments = f.split(/[\\/]/);
          return !segments.some((s) => s === "node_modules" || s.startsWith("."));
        })
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
            this.fileRegistry.set(value.name, value);
            for (const node of value.nodes) {
              if (!this.signalRegistry.has(node.signalName)) {
                this.signalRegistry.set(node.signalName, node.signal);
              }
            }
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
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.tickCount++;
      if (
        this.reconcileEveryNTicks > 0 &&
        this.tickCount % this.reconcileEveryNTicks === 0
      ) {
        await this.reconcileDynamicDefinitions();
      }

      await this.tickRecurring();

      if (this.scheduleReconciler) {
        try {
          await this.scheduleReconciler.tick();
        } catch (err) {
          console.error("[station-broadcast] Schedule reconciler error:", err);
        }
      }

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
    } finally {
      this.ticking = false;
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

    // Use the snapshot if present (dynamic), else file/dynamic registry.
    const definition = this.resolveDefinitionForRun(fresh);
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
      this.snapshotDefinitionCache.delete(bRun.id);
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
    const definition = this.resolveDefinitionForRun(bRun);
    if (!definition) {
      await this.adapter.updateBroadcastRun(bRun.id, {
        status: "failed",
        completedAt: new Date(),
        error: `Definition for "${bRun.broadcastName}" not found`,
      });
      this.snapshotDefinitionCache.delete(bRun.id);
      return;
    }

    // M8: Broadcast-level timeout check. Cancel running children directly so
    // we emit a single terminal `onBroadcastFailed` for this run rather than
    // racing `onBroadcastCancelled` + `onBroadcastFailed`.
    if (bRun.timeout && bRun.startedAt) {
      const elapsed = Date.now() - bRun.startedAt.getTime();
      if (elapsed > bRun.timeout) {
        const nodeRuns = await this.adapter.getNodeRuns(bRun.id);
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
        const error = `Broadcast timed out after ${bRun.timeout}ms`;
        bRun.status = "failed";
        bRun.completedAt = new Date();
        bRun.error = error;
        await this.adapter.updateBroadcastRun(bRun.id, {
          status: "failed",
          completedAt: bRun.completedAt,
          error,
        });
        this.snapshotDefinitionCache.delete(bRun.id);
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
        this.snapshotDefinitionCache.delete(bRun.id);
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
        this.snapshotDefinitionCache.delete(bRun.id);
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
      this.snapshotDefinitionCache.delete(bRun.id);
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
    // Visiting nodes in topological order means every dependency is resolved
    // before its dependents, so propagation completes in a single pass.
    for (const node of topologicalSort(definition.name, definition.nodes)) {
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
    // Parse the broadcast input at most once per pass, and each upstream
    // output at most once per pass (outputs are re-read by every dependent).
    let broadcastInput!: Record<string, unknown>;
    let broadcastInputParsed = false;
    const parsedOutputs = new Map<string, unknown>();

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
        if (!parsedOutputs.has(dep)) {
          parsedOutputs.set(dep, depRun.output ? JSON.parse(depRun.output) : undefined);
        }
        upstreamOutputs[dep] = parsedOutputs.get(dep);
      }

      // M10: when guard always receives upstreamOutputs (broadcast input for root nodes)
      if (!broadcastInputParsed) {
        broadcastInput = JSON.parse(bRun.input);
        broadcastInputParsed = true;
      }
      const guardInput = node.dependsOn.length === 0 ? broadcastInput : upstreamOutputs;
      const evalCtx = { input: broadcastInput, upstream: upstreamOutputs };

      // Evaluate guard — `evalGuard` (dynamic) takes precedence over `when` (static)
      if (node.evalGuard || node.when) {
        let guardResult: boolean;
        try {
          guardResult = node.evalGuard
            ? node.evalGuard(evalCtx)
            : node.when!(guardInput);
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

      // Compute input for this node's signal — M1: wrap evaluator in try/catch.
      // `evalInput` (dynamic) takes precedence over `map` (static).
      let nodeInput: unknown;
      if (node.evalInput) {
        try {
          nodeInput = node.evalInput(evalCtx);
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
      } else if (node.dependsOn.length === 0) {
        nodeInput = broadcastInput;
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
