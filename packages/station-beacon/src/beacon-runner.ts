import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EnvProvider,
  type SignalQueueAdapter,
  type SignalRunner,
  isSerializableAdapter,
} from "station-signal";
import type { AnyBeacon } from "./beacon.js";
import { computeBackoffMs, shouldResetBackoff, shouldRestart } from "./backoff.js";
import type { BeaconInstanceFilter, BeaconStateAdapter } from "./adapters/index.js";
import { BeaconMemoryAdapter } from "./adapters/memory.js";
import {
  BeaconInstanceExistsError,
  BeaconInstanceLimitError,
  BeaconInstanceNotFoundError,
  BeaconValidationError,
} from "./errors.js";
import type { BeaconIPCMessage, BeaconJobInitMessage, BeaconSubscriber } from "./subscribers/index.js";
import {
  type BeaconInstance,
  type BeaconInstancePatch,
  type ExitReason,
  FATAL_EXIT_CODE,
  MAX_INSTANCE_ID_LENGTH,
  VALID_INSTANCE_ID,
} from "./types.js";
import { isBeacon } from "./util.js";

const BOOTSTRAP = fileURLToPath(new URL("./bootstrap.js", import.meta.url));

/** Fallback cap on instances per beacon when the definition doesn't set its own. */
const DEFAULT_MAX_INSTANCES_PER_BEACON = 100;

let _tsxImport: string | undefined;
function getTsxImport(): string | undefined {
  if (_tsxImport !== undefined) return _tsxImport || undefined;
  if (process.env.__STATION_TSX) {
    _tsxImport = process.env.__STATION_TSX;
    return _tsxImport;
  }
  try {
    _tsxImport = import.meta.resolve("tsx");
    return _tsxImport;
  } catch {
    _tsxImport = "";
    return undefined;
  }
}

interface RegisteredBeacon {
  beacon: AnyBeacon;
  filePath: string;
}

/** Volatile, in-process supervision state for the live incarnation of an instance. */
interface Supervised {
  child?: ChildProcess;
  /** The supervisor asked this incarnation to stop (SIGTERM sent). */
  stopRequested: boolean;
  /** This incarnation was killed for missing its heartbeat deadline. */
  stalled: boolean;
  /** This incarnation was killed for not becoming ready within the startup deadline. */
  startupTimedOut?: boolean;
  /** The child reported a fatal (non-restartable) error, e.g. invalid config. */
  fatal?: boolean;
  /** After this incarnation exits, restart it immediately regardless of policy. */
  forceRestart: boolean;
  /** Set once the distributed controller lease can no longer be renewed. */
  leaseLost?: boolean;
  /**
   * The instance is being deleted — exit handling must not schedule a restart
   * or resurrect the record that `deleteInstance` is about to remove.
   */
  removing?: boolean;
  /** Guards against handling both 'error' and 'exit' for one incarnation. */
  exitHandled: boolean;
  /** When the child was spawned — used for uptime / backoff-reset math. */
  startedAtMs?: number;
  /** When the handler reported it started — the baseline for heartbeat stalls. */
  runningSinceMs?: number;
  lastHeartbeatMs?: number;
  /** SIGKILL escalation timer armed when a stop was requested. */
  killTimer?: ReturnType<typeof setTimeout>;
}

/** Options for creating a beacon instance at runtime. */
export interface CreateInstanceOptions {
  /**
   * Instance id. Must be unique across all beacons, and is what the API and
   * dashboard address the instance by. Generated from the beacon name when
   * omitted.
   */
  id?: string;
  /** Optional human-readable label. */
  label?: string;
  /** Config for this instance — validated against the beacon's config schema. */
  config?: unknown;
  /** Start the instance immediately. @default true */
  start?: boolean;
}

/** Options for patching an existing instance. */
export interface UpdateInstanceOptions {
  /** Replace the instance's config. Takes effect on the next start. */
  config?: unknown;
  /** Replace the instance's label. */
  label?: string;
  /** Restart a running instance so the new config takes effect now. @default false */
  restart?: boolean;
}

export interface BeaconRunnerOptions {
  beaconsDir?: string;
  adapter?: BeaconStateAdapter;
  /** Supervisor reconcile cadence. @default 1000 */
  pollIntervalMs?: number;
  subscribers?: BeaconSubscriber[];
  /**
   * Wire a SignalRunner so beacon handlers can `signal.trigger()` into the same
   * queue the SignalRunner drains. Its adapter manifest is passed to children.
   */
  signalRunner?: SignalRunner;
  /** Alternatively, pass a signal queue adapter directly (advanced). */
  signalAdapter?: SignalQueueAdapter;
  /**
   * Optional source of runtime-managed env vars (wire `station-env`'s
   * `EnvStore` here). Resolved vars are sent to each child over IPC and
   * applied to its process.env before the beacon file is imported; they also
   * satisfy `.env()` requirements, alongside the host process env.
   */
  envProvider?: EnvProvider;
  /**
   * Default cap on concurrent instances per beacon, applied to beacons that
   * don't declare their own `.maxInstances()`. Bounds how many processes a
   * runtime caller can spawn. @default 100
   */
  maxInstancesPerBeacon?: number;
  networkCoordinator?: {
    acquireControllerLease(lease: { name:string; holderId:string; token:string; expiresAt:Date }, now:Date):Promise<boolean>;
    renewControllerLease(name:string,holderId:string,token:string,expiresAt:Date,now?:Date):Promise<boolean>;
    releaseControllerLease(name:string,holderId:string,token:string):Promise<boolean>;
    getControllerLease?(name:string):Promise<{holderId:string;token:string;expiresAt:Date}|null>;
  };
  networkId?: string;
  stationId?: string;
  stationLabels?: Record<string,string>;
  leaseDurationMs?: number;
  canClaim?: () => Promise<boolean>;
}

/**
 * Supervises long-running beacon processes. Each running beacon instance gets
 * its own child process; the supervisor keeps it alive per its restart policy,
 * applies exponential backoff between restarts, detects heartbeat stalls, and
 * reconciles a per-instance desired state (running/stopped) you can flip at
 * runtime.
 *
 * A beacon definition can back many instances. Beacons with start mode `auto`
 * or `manual` get one instance seeded from the file (its id is the beacon
 * name); any beacon can additionally have instances created at runtime via
 * {@link BeaconRunner.createInstance}, each with its own config.
 */
export class BeaconRunner {
  private adapter: BeaconStateAdapter;
  private beaconsDir?: string;
  private pollIntervalMs: number;
  private subscribers: BeaconSubscriber[];
  private registry = new Map<string, RegisteredBeacon>();
  /** Authoritative working copy of instance records, keyed by instance id. */
  private instances = new Map<string, BeaconInstance>();
  private supervised = new Map<string, Supervised>();
  private maxInstancesPerBeacon: number;

  private signalAdapterName?: string;
  private signalAdapterOptions?: Record<string, unknown>;
  private signalAdapterImport?: string;
  private envProvider?: EnvProvider;
  private networkCoordinator?: BeaconRunnerOptions["networkCoordinator"];
  private networkId: string;
  private stationId: string;
  private stationLabels: Record<string,string>;
  private leaseDurationMs: number;
  private canClaim?: () => Promise<boolean>;
  private networkLeaseByInstance = new Map<string,{name:string;token:string}>();

  private running = false;
  private stopping = false;
  private ticking = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollResolve: (() => void) | null = null;
  /** Resolves once start() has finished discovery, hydration, and seeding. */
  private readyPromise: Promise<void>;
  private markReady!: () => void;

  constructor(options: BeaconRunnerOptions = {}) {
    this.adapter = options.adapter ?? new BeaconMemoryAdapter();
    this.beaconsDir = options.beaconsDir;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.subscribers = options.subscribers ? [...options.subscribers] : [];
    this.maxInstancesPerBeacon =
      options.maxInstancesPerBeacon ?? DEFAULT_MAX_INSTANCES_PER_BEACON;

    const signalAdapter = options.signalAdapter ?? options.signalRunner?.getAdapter();
    if (signalAdapter && isSerializableAdapter(signalAdapter)) {
      const manifest = signalAdapter.toManifest();
      this.signalAdapterName = manifest.name;
      this.signalAdapterOptions = manifest.options;
      this.signalAdapterImport = manifest.moduleUrl;
    }
    this.envProvider = options.envProvider;
    this.networkCoordinator = options.networkCoordinator;
    this.networkId = options.networkId ?? "default";
    this.stationId = options.stationId ?? `station-${process.pid}`;
    this.stationLabels = { ...(options.stationLabels ?? {}) };
    this.leaseDurationMs = Math.max(options.leaseDurationMs ?? 30_000, this.pollIntervalMs * 3);
    this.canClaim = options.canClaim;
    this.readyPromise = this.armReady();
  }

  private armReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /**
   * Resolves once `start()` has discovered beacons, hydrated persisted
   * instances, and seeded definition-owned ones — i.e. once `listInstances()`
   * and the instance controls see the full picture. `start()` itself never
   * settles while the supervisor is running, so callers that serve an API on
   * top of the runner should await this instead.
   */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  static create(
    beaconsDir: string,
    options: Omit<BeaconRunnerOptions, "beaconsDir"> = {},
  ): BeaconRunner {
    return new BeaconRunner({ ...options, beaconsDir });
  }

  // ─── Registration / discovery ──────────────────────────────────────

  /** Register a beacon explicitly (alternative to auto-discovery). Call before start(). */
  register(beacon: AnyBeacon, filePath: string): this {
    if (this.running) {
      console.warn(
        `[station-beacon] register("${beacon.name}") called after start() — it will not be seeded or supervised. Register beacons before start().`,
      );
    }
    if (this.registry.has(beacon.name)) {
      console.warn(`[station-beacon] Duplicate beacon name "${beacon.name}" — overwriting.`);
    }
    this.registry.set(beacon.name, { beacon, filePath: resolve(filePath) });
    return this;
  }

  subscribe(subscriber: BeaconSubscriber): this {
    this.subscribers.push(subscriber);
    return this;
  }

  /** List registered beacons with metadata. */
  listRegistered(): Array<{
    name: string;
    filePath: string;
    mode: "run" | "poll";
    restartPolicy: string;
    startMode: string;
    autoStart: boolean;
    maxInstances: number;
    requiredEnv?: string[];
  }> {
    return Array.from(this.registry.values()).map(({ beacon, filePath }) => ({
      name: beacon.name,
      filePath,
      mode: beacon.mode,
      restartPolicy: beacon.restartPolicy,
      startMode: beacon.startMode,
      autoStart: beacon.autoStart,
      maxInstances: beacon.maxInstances ?? this.maxInstancesPerBeacon,
      requiredEnv: beacon.requiredEnv,
    }));
  }

  hasBeacon(name: string): boolean {
    return this.registry.has(name);
  }

  getBeacon(name: string): AnyBeacon | undefined {
    return this.registry.get(name)?.beacon;
  }

  /**
   * An instance record by id (status, desired state, counters). The
   * definition-owned instance of a beacon uses the beacon name as its id.
   */
  async getInstance(instanceId: string): Promise<BeaconInstance | null> {
    const local = this.instances.get(instanceId);
    if (local) return { ...local }; // copy — never leak the live internal record
    return this.adapter.getInstance(instanceId);
  }

  /** All known instance records, optionally narrowed to one beacon. */
  async listInstances(filter?: BeaconInstanceFilter): Promise<BeaconInstance[]> {
    const all = Array.from(this.instances.values());
    const scoped = filter?.beaconName
      ? all.filter((i) => i.beaconName === filter.beaconName)
      : all;
    return scoped.map((i) => ({ ...i }));
  }

  /** Lifecycle events for one instance, newest first. */
  async listInstanceEvents(instanceId: string, limit = 100) {
    return this.adapter.listEvents?.(instanceId, limit) ?? [];
  }

  /** Lifecycle events across every instance of a beacon, newest first. */
  async listBeaconEvents(beaconName: string, limit = 100) {
    if (this.adapter.listBeaconEvents) return this.adapter.listBeaconEvents(beaconName, limit);
    // Older adapters only index by instance — merge each instance's slice.
    if (!this.adapter.listEvents) return [];
    const ids = (await this.listInstances({ beaconName })).map((i) => i.id);
    const batches = await Promise.all(ids.map((id) => this.adapter.listEvents!(id, limit)));
    return batches
      .flat()
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, limit);
  }

  private async discover(dir: string): Promise<void> {
    let files: string[];
    try {
      const entries = await readdir(dir, { recursive: true });
      files = entries
        .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts"))
        // Importing a file executes it — never auto-execute dependencies or
        // hidden files that happen to live under beaconsDir.
        .filter((f) => {
          const parts = f.split(/[\\/]/);
          return !parts.some((p) => p === "node_modules" || p.startsWith("."));
        })
        .map((f) => join(dir, f));
    } catch {
      console.error(`[station-beacon] Cannot read beaconsDir: ${dir}`);
      return;
    }

    for (const filePath of files) {
      try {
        const mod = await import(filePath);
        for (const value of Object.values(mod)) {
          if (isBeacon(value)) {
            if (this.registry.has(value.name)) {
              console.warn(
                `[station-beacon] Duplicate beacon name "${value.name}" — overwriting with ${filePath}`,
              );
            }
            this.registry.set(value.name, { beacon: value, filePath });
            this.emit("onBeaconDiscovered", { beaconName: value.name, filePath });
          }
        }
      } catch (err) {
        console.warn(
          `[station-beacon] Skipping ${filePath} — failed to import (if .ts, ensure a TypeScript loader like tsx is active):`,
          err,
        );
      }
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("[station-beacon] Runner is already started");
    }
    // Clear the stop latch so a runner can be restarted after stop(). Without
    // this, a second start() would run with reconcile()/spawnBeacon() short-
    // circuiting on `stopping`, silently supervising nothing.
    this.stopping = false;
    // Re-arm readiness so a caller awaiting whenReady() after a restart waits
    // for this boot's seeding, not the previous one's.
    this.readyPromise = this.armReady();

    if (this.beaconsDir) {
      await this.discover(resolve(this.beaconsDir));
    }

    // Rebuild the instance world from the adapter on every boot. Dropping the
    // in-memory copies first matters when a runner is restarted in-process:
    // the stale records would otherwise shadow what hydrate() loads, and a
    // volatile adapter (which forgets everything on close) could never re-seed
    // from the definitions.
    this.instances.clear();
    this.supervised.clear();

    // Adopt every persisted instance — including ones created at runtime in a
    // previous supervisor lifetime, which have no counterpart in any file.
    await this.hydrate();

    // Seed the definition-owned instance for beacons that have one.
    for (const { beacon } of this.registry.values()) {
      if (beacon.startMode === "on-demand") continue;
      await this.seedOrResumeDefinitionInstance(beacon);
    }

    this.markReady();

    const shutdown = () => {
      console.log("[station-beacon] Received shutdown signal, stopping...");
      this.stop({ graceful: true, timeoutMs: 10_000 }).catch((err) => {
        console.error("[station-beacon] Error during shutdown:", err);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[station-beacon] tick() failed:", err);
      }
      if (!this.running) break; // don't arm a trailing sleep timer after stop()
      await this.sleep(this.pollIntervalMs);
    }

    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  /**
   * Stop the supervisor. With `graceful`, running beacons are asked to stop
   * (SIGTERM) and awaited up to `timeoutMs` before being force-killed. Desired
   * state is left untouched, so a supervisor restart resumes them.
   */
  async stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    // Never leave a whenReady() awaiter hanging on a runner that is shutting
    // down (or was stopped before it ever started).
    this.markReady();
    // Wake the poll loop immediately so start()'s promise settles cleanly
    // instead of being abandoned mid-sleep (which surfaces as an unsettled
    // top-level await warning in callers that `await runner.start()`).
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pollResolve) {
      const resolve = this.pollResolve;
      this.pollResolve = null;
      resolve();
    }

    // Let any in-flight tick finish so a spawn can't race past this point and
    // leave an unmanaged child alive (the spawn guard then blocks new launches).
    while (this.ticking) {
      await new Promise((r) => setTimeout(r, 10));
    }

    if (options?.graceful) {
      for (const [id, sup] of this.supervised) {
        if (sup.child) this.initiateStop(id);
      }
      const timeout = options.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (![...this.supervised.values()].some((s) => s.child)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // Force-kill any survivors (and every child in non-graceful mode).
    for (const sup of this.supervised.values()) {
      if (sup.child) sup.child.kill("SIGKILL");
      if (sup.killTimer) {
        clearTimeout(sup.killTimer);
        sup.killTimer = undefined;
      }
    }

    try {
      await this.adapter.close?.();
    } catch (err) {
      console.error("[station-beacon] Error closing adapter:", err);
    }
  }

  // ─── Instance management ───────────────────────────────────────────

  /**
   * Create a new instance of a beacon at runtime, with its own config, and (by
   * default) start it. This is what lets one beacon definition run many times
   * over — per tenant, per stream, per queue — driven by the API or dashboard.
   */
  async createInstance(
    beaconName: string,
    opts: CreateInstanceOptions = {},
  ): Promise<BeaconInstance> {
    const reg = this.registry.get(beaconName);
    if (!reg) throw new Error(`Beacon "${beaconName}" is not registered`);
    const beacon = reg.beacon;

    // Validate config up front so a bad payload fails the API call rather than
    // silently crash-looping a child process.
    if (opts.config !== undefined) {
      const parsed = beacon.configSchema.safeParse(opts.config);
      if (!parsed.success) {
        throw new BeaconValidationError(beaconName, parsed.error?.message ?? "invalid config");
      }
    }

    const limit = beacon.maxInstances ?? this.maxInstancesPerBeacon;
    const existingCount = Array.from(this.instances.values()).filter(
      (i) => i.beaconName === beaconName,
    ).length;
    if (existingCount >= limit) {
      throw new BeaconInstanceLimitError(beaconName, limit);
    }

    const id = opts.id !== undefined ? this.validateInstanceId(opts.id) : this.generateInstanceId(beaconName);
    // Ids are unique across all beacons: they are adapter primary keys, and the
    // bare beacon name is reserved for the definition-owned instance.
    if (this.instances.has(id) || this.registry.has(id)) {
      throw new BeaconInstanceExistsError(id);
    }
    if (await this.adapter.getInstance(id)) {
      throw new BeaconInstanceExistsError(id);
    }

    const start = opts.start ?? true;
    const now = new Date();
    const config = opts.config !== undefined ? opts.config : beacon.defaultConfig;
    const instance: BeaconInstance = {
      id,
      beaconName,
      label: opts.label,
      origin: "api",
      status: start ? "backoff" : "stopped",
      desiredState: start ? "running" : "stopped",
      incarnation: 0,
      restartCount: 0,
      config: config !== undefined ? JSON.stringify(config) : undefined,
      nextRestartAt: start ? now : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(id, instance);
    this.supervised.set(id, this.freshSupervised());
    await this.adapter.upsertInstance(instance);
    this.emit("onBeaconInstanceCreated", { instance: { ...instance } });
    await this.addEvent(instance, "created", opts.label ? `label=${opts.label}` : undefined);
    // Don't wait a whole poll interval to honour an API-driven start.
    if (start) this.wakePoll();
    return { ...instance };
  }

  /**
   * Stop an instance and remove its record entirely. Only instances created at
   * runtime can be deleted — the definition-owned one is re-seeded from the
   * beacon file on every boot, so stop it instead.
   */
  async deleteInstance(instanceId: string, opts?: { timeoutMs?: number }): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new BeaconInstanceNotFoundError(instanceId);
    if (inst.origin === "definition") {
      throw new Error(
        `Instance "${instanceId}" is owned by the beacon definition and cannot be deleted. Stop it instead.`,
      );
    }

    const sup = this.supervised.get(instanceId);
    if (sup) sup.removing = true;
    await this.patch(instanceId, { desiredState: "stopped" });

    if (sup?.child) {
      this.initiateStop(instanceId);
      const beacon = this.registry.get(inst.beaconName)?.beacon;
      const timeout = opts?.timeoutMs ?? (beacon?.stopTimeoutMs ?? 10_000) + 1_000;
      const deadline = Date.now() + timeout;
      while (sup.child && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // Escalate rather than leave an orphan behind a deleted record.
      if (sup.child) {
        sup.child.kill("SIGKILL");
        sup.child.removeAllListeners();
        sup.child = undefined;
      }
    }
    if (sup?.killTimer) {
      clearTimeout(sup.killTimer);
      sup.killTimer = undefined;
    }

    this.instances.delete(instanceId);
    this.supervised.delete(instanceId);
    try {
      await this.adapter.removeInstance(instanceId);
    } catch (err) {
      console.error(`[station-beacon] Failed to remove instance "${instanceId}":`, err);
    }
    this.emit("onBeaconInstanceRemoved", { instance: { ...inst } });
  }

  /**
   * Patch an instance's config or label. The new config is validated against
   * the beacon's schema and takes effect on the next start — pass
   * `restart: true` to apply it to a running instance immediately.
   */
  async updateInstance(
    instanceId: string,
    opts: UpdateInstanceOptions,
  ): Promise<BeaconInstance> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new BeaconInstanceNotFoundError(instanceId);
    const beacon = this.registry.get(inst.beaconName)?.beacon;

    const patch: BeaconInstancePatch = {};
    if ("config" in opts) {
      if (beacon && opts.config !== undefined) {
        const parsed = beacon.configSchema.safeParse(opts.config);
        if (!parsed.success) {
          throw new BeaconValidationError(inst.beaconName, parsed.error?.message ?? "invalid config");
        }
      }
      patch.config = opts.config !== undefined ? JSON.stringify(opts.config) : undefined;
    }
    if ("label" in opts) patch.label = opts.label;

    await this.patch(instanceId, patch);
    if (opts.restart) await this.restartInstance(instanceId);
    return { ...this.instances.get(instanceId)! };
  }

  // ─── Operator controls ─────────────────────────────────────────────

  /**
   * Start an instance (or ensure it's running). Sets desired state to running
   * and schedules an immediate launch. Optionally overrides its config.
   */
  async startInstance(instanceId: string, opts?: { config?: unknown }): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new BeaconInstanceNotFoundError(instanceId);

    const patch: BeaconInstancePatch = { desiredState: "running" };
    if (opts && "config" in opts) {
      const beacon = this.registry.get(inst.beaconName)?.beacon;
      if (beacon && opts.config !== undefined) {
        const parsed = beacon.configSchema.safeParse(opts.config);
        if (!parsed.success) {
          throw new BeaconValidationError(inst.beaconName, parsed.error?.message ?? "invalid config");
        }
      }
      patch.config = opts.config !== undefined ? JSON.stringify(opts.config) : undefined;
    }
    const sup = this.supervised.get(instanceId);
    if (!sup?.child) {
      // Nothing live — schedule an immediate (re)start and clear any error.
      patch.status = "backoff";
      patch.nextRestartAt = new Date();
      patch.restartCount = 0;
      patch.lastError = undefined;
    } else if (sup.stopRequested) {
      // A start requested while the current incarnation is stopping. It will
      // exit with reason "stopped" (which no policy restarts), so mark it for a
      // forced relaunch — otherwise it would strand at desired=running/stopped.
      sup.forceRestart = true;
    }
    await this.patch(instanceId, patch);
    this.wakePoll();
  }

  /** Stop an instance and keep it stopped (desired state = stopped). */
  async stopInstance(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    await this.patch(instanceId, { desiredState: "stopped" });
    const sup = this.supervised.get(instanceId);
    if (sup?.child && !sup.stopRequested) {
      this.initiateStop(instanceId);
    } else if (inst.status === "backoff") {
      await this.patch(instanceId, { status: "stopped", nextRestartAt: undefined });
    }
  }

  /** Restart an instance now — graceful stop of the current incarnation, then relaunch. */
  async restartInstance(instanceId: string): Promise<void> {
    const sup = this.supervised.get(instanceId);
    if (sup?.child) {
      sup.forceRestart = true;
      await this.patch(instanceId, { desiredState: "running" });
      this.initiateStop(instanceId);
    } else {
      await this.startInstance(instanceId);
    }
  }

  /**
   * Start a beacon's definition-owned instance, seeding it if this is the first
   * time. For `on-demand` beacons there is no such instance — create one with
   * {@link BeaconRunner.createInstance} instead.
   */
  async startBeacon(name: string, opts?: { config?: unknown }): Promise<void> {
    const reg = this.registry.get(name);
    if (!reg) throw new Error(`Beacon "${name}" is not registered`);
    if (reg.beacon.startMode === "on-demand" && !this.instances.has(name)) {
      throw new Error(
        `Beacon "${name}" is on-demand: it has no definition instance to start. ` +
          `Create an instance instead (POST /api/beacons/${name}/instances).`,
      );
    }
    if (!this.instances.has(name)) await this.seedOrResumeDefinitionInstance(reg.beacon);
    await this.startInstance(name, opts);
  }

  /** Stop a beacon's definition-owned instance and keep it stopped. */
  async stopBeacon(name: string): Promise<void> {
    await this.stopInstance(name);
  }

  /** Restart a beacon's definition-owned instance. */
  async restartBeacon(name: string): Promise<void> {
    if (this.instances.has(name)) {
      await this.restartInstance(name);
    } else {
      await this.startBeacon(name);
    }
  }

  /** Stop every instance of a beacon, definition-owned and runtime-created alike. */
  async stopAllInstances(beaconName: string): Promise<number> {
    const ids = Array.from(this.instances.values())
      .filter((i) => i.beaconName === beaconName)
      .map((i) => i.id);
    for (const id of ids) await this.stopInstance(id);
    return ids.length;
  }

  // ─── Seeding / reconciliation ──────────────────────────────────────

  /**
   * Load every persisted instance record into memory. This is what makes
   * runtime-created instances durable: they exist only in the adapter, so
   * without this pass a supervisor restart would forget them.
   */
  private async hydrate(): Promise<void> {
    let records: BeaconInstance[];
    try {
      records = await this.adapter.listInstances();
    } catch (err) {
      console.error("[station-beacon] Failed to load persisted instances:", err);
      return;
    }

    for (const rec of records) {
      // Records written before multi-instance support have no id/origin.
      const instance: BeaconInstance = {
        ...rec,
        id: rec.id ?? rec.beaconName,
        origin: rec.origin ?? "definition",
      };
      this.instances.set(instance.id, instance);
      this.supervised.set(instance.id, this.freshSupervised());

      if (!this.registry.has(instance.beaconName)) {
        // A network is intentionally heterogeneous: another station may own a
        // definition this station does not have. Never corrupt its shared
        // lifecycle record by declaring it orphaned here.
        if (this.networkCoordinator) continue;
        // The beacon file is gone (renamed, deleted, or not in beaconsDir).
        // Keep the record so it stays visible and recoverable, but surface why
        // nothing is happening. Desired state is left alone, so restoring the
        // file brings the instance back on the next boot.
        const error = `Beacon "${instance.beaconName}" is not registered — its definition was not found.`;
        await this.patch(instance.id, { status: "errored", lastError: error, pid: undefined });
        console.warn(`[station-beacon] Orphaned instance "${instance.id}": ${error}`);
        continue;
      }

      // On boot no child is live, so any desired-running instance is
      // rescheduled to launch; desired-stopped ones stay put.
      if (instance.desiredState === "running") {
        const restartPatch: BeaconInstancePatch = {
          status: "backoff",
          nextRestartAt: new Date(),
          restartCount: 0,
          pid: undefined,
        };
        if (this.networkCoordinator) this.patchLocal(instance.id, restartPatch);
        else await this.patch(instance.id, restartPatch);
      } else if (
        instance.status === "running" ||
        instance.status === "starting" ||
        instance.status === "stopping"
      ) {
        // Desired-stopped but the record shows an active status — a crash left
        // it stale (no process is actually live on boot). Normalize to stopped.
        if (!this.networkCoordinator) {
          await this.patch(instance.id, { status: "stopped", pid: undefined });
        }
      }
    }
  }

  private async seedOrResumeDefinitionInstance(beacon: AnyBeacon): Promise<void> {
    // hydrate() already adopted it if a record existed.
    if (this.instances.has(beacon.name)) return;

    const existing = await this.adapter.getInstance(beacon.name);
    if (existing) {
      const instance: BeaconInstance = {
        ...existing,
        id: existing.id ?? beacon.name,
        origin: existing.origin ?? "definition",
      };
      this.instances.set(instance.id, instance);
      this.supervised.set(instance.id, this.freshSupervised());
      if (instance.desiredState === "running") {
        const restartPatch: BeaconInstancePatch = {
          status: "backoff",
          nextRestartAt: new Date(),
          restartCount: 0,
          pid: undefined,
        };
        if (this.networkCoordinator) this.patchLocal(instance.id, restartPatch);
        else await this.patch(instance.id, restartPatch);
      }
      return;
    }

    const now = new Date();
    const instance: BeaconInstance = {
      id: beacon.name,
      beaconName: beacon.name,
      origin: "definition",
      status: beacon.autoStart ? "backoff" : "stopped",
      desiredState: beacon.autoStart ? "running" : "stopped",
      incarnation: 0,
      restartCount: 0,
      config: beacon.defaultConfig !== undefined ? JSON.stringify(beacon.defaultConfig) : undefined,
      nextRestartAt: beacon.autoStart ? now : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(instance.id, instance);
    this.supervised.set(instance.id, this.freshSupervised());
    await this.adapter.upsertInstance(instance);
  }

  private freshSupervised(): Supervised {
    return { stopRequested: false, stalled: false, forceRestart: false, exitHandled: true };
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      await this.renewNetworkLeases(new Date(now));
      if (this.networkCoordinator) await this.syncNetworkInstances();
      // Snapshot: reconcile awaits, and an API call can add or delete an
      // instance in the meantime.
      for (const id of Array.from(this.instances.keys())) {
        const inst = this.instances.get(id);
        if (!inst) continue;
        const reg = this.registry.get(inst.beaconName);
        if (!reg) continue; // orphaned record — flagged during hydrate()
        await this.reconcile(reg.beacon, id, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Adopt instances and operator intent written through Headquarters. A
   * standalone runner owns its in-memory view directly, but networked runners
   * share the beacon adapter with the control plane. Polling that adapter here
   * makes create/start/stop requests converge on every eligible station; the
   * per-instance controller lease still guarantees that only one of them can
   * spawn the child.
   */
  private async syncNetworkInstances(): Promise<void> {
    const stored = await this.adapter.listInstances();
    const storedIds = new Set(stored.map((instance) => instance.id));
    for (const remote of stored) {
      if (!this.registry.has(remote.beaconName)) continue;
      const local = this.instances.get(remote.id);
      if (!local) {
        this.instances.set(remote.id, remote.desiredState === "running"
          ? { ...remote, status: "backoff", nextRestartAt: new Date(), pid: undefined }
          : { ...remote });
        this.supervised.set(remote.id, this.freshSupervised());
        continue;
      }

      // Lifecycle state is written by the station holding the execution
      // lease. Other stations only consume operator-controlled fields so a
      // stale observer cannot overwrite the owner's pid/status/heartbeats.
      if (remote.updatedAt > local.updatedAt) {
        const previousDesired = local.desiredState;
        local.desiredState = remote.desiredState;
        local.config = remote.config;
        local.label = remote.label;
        local.updatedAt = remote.updatedAt;

        const supervised = this.supervised.get(remote.id);
        if (remote.desiredState === "running" && remote.status === "backoff" && remote.nextRestartAt) {
          if (supervised?.child) {
            supervised.forceRestart = true;
            if (!supervised.stopRequested) this.initiateStop(remote.id);
          } else {
            local.status = "backoff";
            local.nextRestartAt = remote.nextRestartAt;
            local.lastError = remote.lastError;
          }
        } else if (previousDesired === "stopped" && remote.desiredState === "running" && !supervised?.child) {
          local.status = "backoff";
          local.nextRestartAt = new Date();
        }
      }
    }
    for (const [id, local] of this.instances) {
      if (local.origin !== "api" || storedIds.has(id) || this.supervised.get(id)?.child) continue;
      this.instances.delete(id);
      this.supervised.delete(id);
    }
  }

  private async reconcile(beacon: AnyBeacon, instanceId: string, now: number): Promise<void> {
    if (this.stopping) return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const sup = this.supervised.get(instanceId);
    if (!sup || sup.removing) return;

    // Enforce desired=stopped: stop any live child that shouldn't be running.
    // This is the reconcile safety net that closes the window where a
    // stopInstance() races an in-flight spawn (the child is spawned after
    // stopInstance already saw no child), and guarantees the supervisor always
    // converges to the desired state.
    if (inst.desiredState === "stopped") {
      if (sup.child && !sup.stopRequested) this.initiateStop(instanceId);
      return;
    }

    // Startup-timeout detection — a beacon must reach ready (ctx.ready()) within
    // startupTimeoutMs of spawn. Catches boot/import hangs (never reports
    // started) and "started but never came up" handlers. Only applies before
    // readiness; once ready, heartbeat detection takes over.
    if (
      beacon.startupTimeoutMs &&
      sup.child &&
      !sup.stopRequested &&
      !inst.readyAt &&
      (inst.status === "starting" || inst.status === "running") &&
      sup.startedAtMs !== undefined &&
      now - sup.startedAtMs > beacon.startupTimeoutMs
    ) {
      sup.startupTimedOut = true;
      const error = `Startup timed out after ${beacon.startupTimeoutMs}ms (never became ready)`;
      await this.patch(instanceId, { lastError: error });
      this.emit("onBeaconStalled", { instance: { ...this.instances.get(instanceId)! } });
      await this.addEvent(inst, "stalled", error);
      this.initiateStop(instanceId);
      return;
    }

    // Heartbeat stall detection — only once the handler has actually started,
    // so process boot time never counts against the heartbeat deadline.
    if (
      beacon.heartbeatTimeoutMs &&
      sup.child &&
      !sup.stopRequested &&
      inst.status === "running" &&
      sup.runningSinceMs !== undefined
    ) {
      const last = sup.lastHeartbeatMs ?? sup.runningSinceMs;
      if (now - last > beacon.heartbeatTimeoutMs) {
        sup.stalled = true;
        const error = `Heartbeat stalled (no heartbeat within ${beacon.heartbeatTimeoutMs}ms)`;
        await this.patch(instanceId, { lastError: error });
        this.emit("onBeaconStalled", { instance: { ...this.instances.get(instanceId)! } });
        await this.addEvent(inst, "stalled", error);
        this.initiateStop(instanceId);
        return;
      }
    }

    // Launch when scheduled and nothing is live.
    if (
      inst.desiredState === "running" &&
      !sup.child &&
      inst.status === "backoff" &&
      inst.nextRestartAt &&
      inst.nextRestartAt.getTime() <= now
    ) {
      await this.spawnBeacon(beacon, instanceId);
    }
  }

  // ─── Spawn ─────────────────────────────────────────────────────────

  private async spawnBeacon(beacon: AnyBeacon, instanceId: string): Promise<void> {
    const reg = this.registry.get(beacon.name)!;
    const inst = this.instances.get(instanceId)!;
    const incarnation = inst.incarnation + 1;

    // Resolve store-managed env vars and enforce `.env()` requirements before
    // spending a process on a beacon that cannot come up. Missing vars are a
    // config problem — restarting won't fix them — so mark the instance
    // errored (terminal) instead of entering a restart loop. startInstance()
    // clears the error, so the operator can retry after defining the var.
    let injectedEnv: Record<string, string> | undefined;
    let envProviderErrored = false;
    if (this.envProvider) {
      try {
        injectedEnv = await this.envProvider.resolveFor({ kind: "beacon", name: beacon.name });
      } catch (err) {
        envProviderErrored = true;
        console.error(`[station-beacon] Env provider failed for "${beacon.name}":`, err);
      }
    }
    if (beacon.requiredEnv && beacon.requiredEnv.length > 0) {
      const missing = beacon.requiredEnv.filter(
        (key) => !(injectedEnv && key in injectedEnv) && process.env[key] === undefined,
      );
      if (missing.length > 0) {
        if (envProviderErrored) {
          // The env store was unreachable — this is transient, not a
          // misconfiguration, so reschedule a backoff retry rather than going
          // terminally errored (which would keep the beacon down until an
          // operator manually restarted it after the store recovered).
          const delayMs = beacon.backoff.baseMs;
          const nextRestartAt = new Date(Date.now() + delayMs);
          const reason = `Env store unreachable while resolving required vars for "${beacon.name}" — will retry`;
          await this.patch(instanceId, { status: "backoff", nextRestartAt, lastError: reason });
          this.emit("onBeaconRestartScheduled", {
            instance: { ...this.instances.get(instanceId)! },
            delayMs,
            nextRestartAt,
          });
          await this.addEvent(inst, "restart-scheduled", reason);
          return;
        }
        const error =
          `Missing required environment variable${missing.length > 1 ? "s" : ""} for "${beacon.name}": ` +
          `${missing.join(", ")}. Define ${missing.length > 1 ? "them" : "it"} in the Station env store or the host environment.`;
        await this.patch(instanceId, { status: "errored", lastError: error, nextRestartAt: undefined });
        this.emit("onBeaconErrored", { instance: { ...this.instances.get(instanceId)! }, error });
        await this.addEvent(inst, "errored", error);
        return;
      }
    }

    const requiredLabels = beacon.placement?.labels;
    if (requiredLabels && !Object.entries(requiredLabels).every(([key,value]) => this.stationLabels[key] === value)) return;
    if (this.canClaim && !(await this.canClaim())) return;
    const networkLease = await this.acquireNetworkLease(beacon.name, instanceId);
    if (this.networkCoordinator && !networkLease) return;

    await this.patch(instanceId, {
      status: "starting",
      incarnation,
      startedAt: new Date(),
      readyAt: undefined,
      nextRestartAt: undefined,
      stationId: this.stationId,
      exposure: undefined,
    });
    this.emit("onBeaconStarting", { instance: { ...this.instances.get(instanceId)! } });
    await this.addEvent(this.instances.get(instanceId)!, "starting");

    // Only non-sensitive identifiers go through the environment (readable via
    // /proc/<pid>/environ by any same-user process). The beacon config and the
    // signal-adapter options — which may contain DB credentials — are sent over
    // the private IPC channel below (job:init).
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      STATION_BEACON_NAME: beacon.name,
      STATION_BEACON_INSTANCE_ID: instanceId,
      STATION_BEACON_FILE: reg.filePath,
      STATION_BEACON_INCARNATION: String(incarnation),
      STATION_BEACON_STOP_TIMEOUT: String(beacon.stopTimeoutMs),
    };

    // A stop may have been requested while we prepared to launch. Bail before
    // spawning so we never leave a child the stop sweep has already passed.
    if (this.stopping) {
      await this.releaseNetworkLease(instanceId);
      return;
    }
    const supBefore = this.supervised.get(instanceId);
    if (!supBefore || supBefore.removing) {
      await this.releaseNetworkLease(instanceId);
      return;
    }

    const tsxImport = getTsxImport();
    const nodeArgs = tsxImport ? ["--import", tsxImport, BOOTSTRAP] : [BOOTSTRAP];
    const child = spawn("node", nodeArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const jobInit: BeaconJobInitMessage = {
      type: "job:init",
      data: {
        config: inst.config ?? "{}",
        signalAdapterName: this.signalAdapterName,
        signalAdapterOptions: this.signalAdapterOptions,
        signalAdapterImport: this.signalAdapterImport,
        env: injectedEnv && Object.keys(injectedEnv).length > 0 ? injectedEnv : undefined,
      },
    };
    try {
      child.send(jobInit);
    } catch (err) {
      console.error(`[station-beacon] Failed to send job:init to "${instanceId}":`, err);
    }
    // The supervisor's own poll loop keeps this process alive; a child must not.
    // Otherwise a lingering beacon would prevent the supervisor from exiting.
    // (stdout/stderr are sockets at runtime, but typed as Readable without unref.)
    child.unref();
    (child.stdout as unknown as { unref?: () => void } | null)?.unref?.();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();

    const sup: Supervised = {
      child,
      stopRequested: false,
      stalled: false,
      forceRestart: false,
      exitHandled: false,
      startedAtMs: Date.now(),
    };
    this.supervised.set(instanceId, sup);
    await this.patch(instanceId, { pid: child.pid });

    child.on("message", (msg: BeaconIPCMessage) => {
      this.handleMessage(instanceId, msg).catch((err) =>
        console.error(`[station-beacon] message handler error for "${instanceId}":`, err),
      );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.emitLog(instanceId, "stdout", chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.emitLog(instanceId, "stderr", chunk.toString());
    });
    child.on("error", (err) => {
      console.error(`[station-beacon] Failed to spawn "${instanceId}":`, err);
      void this.handleExit(beacon, instanceId, null, err.message);
    });
    child.on("exit", (code) => {
      void this.handleExit(beacon, instanceId, code);
    });
  }

  private async handleMessage(instanceId: string, msg: BeaconIPCMessage): Promise<void> {
    const sup = this.supervised.get(instanceId);
    if (!sup || sup.leaseLost) return;
    if (!(await this.ownsNetworkLease(instanceId))) {
      sup.leaseLost = true;
      sup.child?.kill("SIGTERM");
      return;
    }
    switch (msg.type) {
      case "beacon:started": {
        sup.runningSinceMs = Date.now();
        if (!sup.stopRequested) {
          await this.patch(instanceId, { status: "running" });
        }
        this.emit("onBeaconStarted", { instance: { ...this.instances.get(instanceId)! } });
        break;
      }
      case "beacon:ready": {
        await this.patch(instanceId, { readyAt: new Date() });
        const inst = this.instances.get(instanceId)!;
        this.emit("onBeaconReady", { instance: { ...inst } });
        await this.addEvent(inst, "ready");
        break;
      }
      case "beacon:heartbeat": {
        sup.lastHeartbeatMs = Date.now();
        await this.patch(instanceId, { lastHeartbeatAt: new Date() });
        this.emit("onBeaconHeartbeat", { instance: { ...this.instances.get(instanceId)! } });
        break;
      }
      case "beacon:exposed": {
        const exposure = msg.data?.exposure;
        if (exposure && typeof exposure === "object") {
          await this.patch(instanceId, { exposure: JSON.stringify(exposure), stationId: this.stationId });
        }
        break;
      }
      case "beacon:error": {
        const error = (msg.data?.error as string) ?? "Unknown error";
        await this.patch(instanceId, { lastError: error });
        if (msg.data?.fatal) {
          // Config/definition errors are fatal — mark for terminal errored state.
          sup.forceRestart = false;
          sup.fatal = true;
        }
        break;
      }
      case "beacon:log": {
        this.emitLog(instanceId, "log", (msg.data?.message as string) ?? "");
        break;
      }
      case "beacon:stopping":
        break;
    }
  }

  // ─── Exit handling ─────────────────────────────────────────────────

  private async handleExit(
    beacon: AnyBeacon,
    instanceId: string,
    code: number | null,
    spawnError?: string,
  ): Promise<void> {
    const sup = this.supervised.get(instanceId);
    if (!sup || sup.exitHandled) return;
    sup.exitHandled = true;

    if (sup.killTimer) {
      clearTimeout(sup.killTimer);
      sup.killTimer = undefined;
    }
    const uptimeMs = sup.startedAtMs ? Date.now() - sup.startedAtMs : 0;
    const child = sup.child;
    sup.child = undefined;
    child?.removeAllListeners();
    const ownedAtExit = await this.ownsNetworkLease(instanceId);
    await this.releaseNetworkLease(instanceId);

    // A new station may already own this instance. The stale process must not
    // publish exit/restart state over the new owner's record.
    if (sup.leaseLost || !ownedAtExit) return;

    // The instance is being deleted — deleteInstance() is waiting on the child
    // to clear and will drop the record. Recording state or scheduling a
    // restart here would resurrect it.
    if (sup.removing) return;

    const reason: ExitReason = sup.startupTimedOut
      ? "startup-timeout"
      : sup.stalled
        ? "stalled"
        : sup.stopRequested || this.stopping
          ? "stopped"
          : code === 0
            ? "clean"
            : "failure";

    const inst = this.instances.get(instanceId);
    if (!inst) return;
    await this.patch(instanceId, {
      pid: undefined,
      readyAt: undefined,
      lastExitAt: new Date(),
      lastExitReason: reason,
      ...(spawnError ? { lastError: spawnError } : {}),
    });
    this.emit("onBeaconExited", { instance: { ...this.instances.get(instanceId)! }, reason, code });
    await this.addEvent(inst, "exited", `reason=${reason} code=${code ?? "null"}`);

    // Forced restart (operator restart) takes precedence and ignores policy.
    if (sup.forceRestart && !this.stopping) {
      await this.scheduleRestart(instanceId, 0, 0);
      return;
    }

    // Fatal error (bad config / missing beacon) → terminal, never restart.
    // The sentinel exit code is authoritative because the `fatal` IPC flag can
    // race (or be lost to) the child's exit.
    const fatal = sup.fatal || code === FATAL_EXIT_CODE;
    if (fatal) {
      const error = inst.lastError ?? "fatal error (invalid config or beacon not found)";
      await this.patch(instanceId, { status: "errored", lastError: error });
      this.emit("onBeaconErrored", {
        instance: { ...this.instances.get(instanceId)! },
        error,
      });
      await this.addEvent(inst, "errored", error);
      return;
    }

    const willRestart =
      !this.stopping && shouldRestart(beacon.restartPolicy, reason, inst.desiredState);

    if (willRestart) {
      const attempt = shouldResetBackoff(uptimeMs, beacon.backoff) ? 0 : inst.restartCount;
      const delay = computeBackoffMs(attempt, beacon.backoff);
      await this.scheduleRestart(instanceId, delay, attempt + 1);
      return;
    }

    // No restart. Distinguish a terminal failure from a completed/stopped beacon.
    if (reason === "failure" || reason === "stalled" || reason === "startup-timeout") {
      await this.patch(instanceId, { status: "errored" });
      this.emit("onBeaconErrored", {
        instance: { ...this.instances.get(instanceId)! },
        error: inst.lastError,
      });
      await this.addEvent(inst, "errored", inst.lastError);
    } else {
      // clean self-completion: mark desired stopped so we don't relaunch it.
      const patch: BeaconInstancePatch = { status: "stopped" };
      if (reason === "clean") patch.desiredState = "stopped";
      await this.patch(instanceId, patch);
      this.emit("onBeaconStopped", { instance: { ...this.instances.get(instanceId)! } });
      await this.addEvent(inst, "stopped");
    }
  }

  private async acquireNetworkLease(
    beaconName: string,
    instanceId: string,
  ): Promise<{ name: string; token: string } | undefined> {
    if (!this.networkCoordinator) return undefined;
    const now = new Date();
    const token = randomUUID();
    const name = `network:${this.networkId}:beacon:${beaconName}:${instanceId}`;
    const acquired = await this.networkCoordinator.acquireControllerLease({
      name,
      holderId: this.stationId,
      token,
      expiresAt: new Date(now.getTime() + this.leaseDurationMs),
    }, now);
    if (!acquired) return undefined;
    const lease = { name, token };
    this.networkLeaseByInstance.set(instanceId, lease);
    return lease;
  }

  private async renewNetworkLeases(now: Date): Promise<void> {
    if (!this.networkCoordinator) return;
    for (const [instanceId, lease] of this.networkLeaseByInstance) {
      const renewed = await this.networkCoordinator.renewControllerLease(
        lease.name,
        this.stationId,
        lease.token,
        new Date(now.getTime() + this.leaseDurationMs),
        now,
      );
      if (!renewed) {
        const supervised = this.supervised.get(instanceId);
        if (supervised) supervised.leaseLost = true;
        supervised?.child?.kill("SIGTERM");
      }
    }
  }

  private async releaseNetworkLease(instanceId: string): Promise<void> {
    const lease = this.networkLeaseByInstance.get(instanceId);
    if (!lease || !this.networkCoordinator) return;
    this.networkLeaseByInstance.delete(instanceId);
    await this.networkCoordinator.releaseControllerLease(lease.name, this.stationId, lease.token);
  }

  private async ownsNetworkLease(instanceId: string): Promise<boolean> {
    if (!this.networkCoordinator) return true;
    const local = this.networkLeaseByInstance.get(instanceId);
    if (!local) return false;
    if (!this.networkCoordinator.getControllerLease) return true;
    try {
      const current = await this.networkCoordinator.getControllerLease(local.name);
      return Boolean(current && current.holderId === this.stationId && current.token === local.token
        && current.expiresAt > new Date());
    } catch {
      return false;
    }
  }

  private async scheduleRestart(
    instanceId: string,
    delayMs: number,
    restartCount: number,
  ): Promise<void> {
    const nextRestartAt = new Date(Date.now() + delayMs);
    await this.patch(instanceId, {
      status: "backoff",
      restartCount,
      nextRestartAt,
    });
    // Reset volatile state for the next incarnation.
    this.supervised.set(instanceId, this.freshSupervised());
    const inst = this.instances.get(instanceId)!;
    this.emit("onBeaconRestartScheduled", {
      instance: { ...inst },
      delayMs,
      nextRestartAt,
    });
    await this.addEvent(inst, "restart-scheduled", `in ${delayMs}ms`);
  }

  /**
   * Request a graceful stop over IPC (falling back to SIGTERM), and arm a
   * SIGKILL escalation timer at the beacon's stop timeout so a handler that
   * ignores the stop can't hang the supervisor.
   */
  private initiateStop(instanceId: string): void {
    const sup = this.supervised.get(instanceId);
    const inst = this.instances.get(instanceId);
    const beacon = inst ? this.registry.get(inst.beaconName)?.beacon : undefined;
    if (!sup?.child || sup.stopRequested) return;
    sup.stopRequested = true;
    void this.patch(instanceId, { status: "stopping" });
    const child = sup.child;
    try {
      const delivered = child.send({ type: "stop" }, (err: Error | null) => {
        if (err) child.kill("SIGTERM");
      });
      if (!delivered) child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const timeout = beacon?.stopTimeoutMs ?? 10_000;
    sup.killTimer = setTimeout(() => {
      sup.child?.kill("SIGKILL");
    }, timeout);
    sup.killTimer.unref?.();
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /** Reject ids that can't safely be an adapter primary key or a URL segment. */
  private validateInstanceId(id: string): string {
    if (!VALID_INSTANCE_ID.test(id) || id.length > MAX_INSTANCE_ID_LENGTH) {
      throw new Error(
        `Invalid instance id "${id}". Ids must start with a letter or digit, contain only ` +
          `letters, digits, and the characters . _ : -, and be at most ${MAX_INSTANCE_ID_LENGTH} characters.`,
      );
    }
    return id;
  }

  private generateInstanceId(beaconName: string): string {
    // Prefixed with the beacon name so ids stay readable in logs and URLs; the
    // random suffix keeps them unique without a round trip to the adapter.
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = `${beaconName}-${randomBytes(4).toString("hex")}`;
      if (id.length <= MAX_INSTANCE_ID_LENGTH && !this.instances.has(id)) return id;
    }
    return `${beaconName.slice(0, 32)}-${randomBytes(8).toString("hex")}`;
  }

  /** Nudge the poll loop so an API-driven start doesn't wait out the interval. */
  private wakePoll(): void {
    if (!this.running || this.pollResolve === null) return;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const resolve = this.pollResolve;
    this.pollResolve = null;
    resolve();
  }

  private emitLog(instanceId: string, level: "log" | "stdout" | "stderr", message: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.emit("onBeaconLog", { instance: { ...inst }, level, message });
  }

  private async patch(instanceId: string, patch: BeaconInstancePatch): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    Object.assign(inst, patch);
    inst.updatedAt = new Date();
    this.instances.set(instanceId, inst);
    try {
      await this.adapter.updateInstance(instanceId, { ...patch, updatedAt: inst.updatedAt });
    } catch (err) {
      console.error(`[station-beacon] Failed to persist instance "${instanceId}":`, err);
    }
  }

  /** Update a contender's private view without overwriting the shared owner. */
  private patchLocal(instanceId: string, patch: BeaconInstancePatch): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    Object.assign(inst, patch);
    this.instances.set(instanceId, inst);
  }

  private async addEvent(
    instance: BeaconInstance,
    type: Parameters<NonNullable<BeaconStateAdapter["addEvent"]>>[0]["type"],
    message?: string,
  ): Promise<void> {
    if (!this.adapter.addEvent) return;
    try {
      await this.adapter.addEvent({
        id: this.adapter.generateId(),
        instanceId: instance.id,
        beaconName: instance.beaconName,
        incarnation: instance.incarnation,
        type,
        message,
        at: new Date(),
      });
    } catch (err) {
      console.error(`[station-beacon] Failed to record event for "${instance.id}":`, err);
    }
  }

  private emit<K extends keyof BeaconSubscriber>(
    event: K,
    data: Parameters<NonNullable<BeaconSubscriber[K]>>[0],
  ): void {
    for (const sub of this.subscribers) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sub[event] as any)?.(data);
      } catch (err) {
        console.error(`[station-beacon] Subscriber error in ${String(event)}:`, err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      this.pollResolve = res;
      this.pollTimer = setTimeout(() => {
        this.pollResolve = null;
        this.pollTimer = null;
        res();
      }, ms);
    });
  }
}
