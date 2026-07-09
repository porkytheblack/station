import { type ChildProcess, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type SignalQueueAdapter,
  type SignalRunner,
  isSerializableAdapter,
} from "station-signal";
import type { AnyBeacon } from "./beacon.js";
import { computeBackoffMs, shouldResetBackoff, shouldRestart } from "./backoff.js";
import type { BeaconStateAdapter } from "./adapters/index.js";
import { BeaconMemoryAdapter } from "./adapters/memory.js";
import type { BeaconIPCMessage, BeaconSubscriber } from "./subscribers/index.js";
import {
  type BeaconInstance,
  type BeaconInstancePatch,
  type ExitReason,
} from "./types.js";
import { isBeacon } from "./util.js";

const BOOTSTRAP = fileURLToPath(new URL("./bootstrap.js", import.meta.url));

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

/** Volatile, in-process supervision state for the live incarnation of a beacon. */
interface Supervised {
  child?: ChildProcess;
  /** The supervisor asked this incarnation to stop (SIGTERM sent). */
  stopRequested: boolean;
  /** This incarnation was killed for missing its heartbeat deadline. */
  stalled: boolean;
  /** The child reported a fatal (non-restartable) error, e.g. invalid config. */
  fatal?: boolean;
  /** After this incarnation exits, restart it immediately regardless of policy. */
  forceRestart: boolean;
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
}

/**
 * Supervises long-running beacon processes. Each enabled beacon runs in its own
 * child process; the supervisor keeps it alive per its restart policy, applies
 * exponential backoff between restarts, detects heartbeat stalls, and reconciles
 * a per-beacon desired state (running/stopped) you can flip at runtime.
 */
export class BeaconRunner {
  private adapter: BeaconStateAdapter;
  private beaconsDir?: string;
  private pollIntervalMs: number;
  private subscribers: BeaconSubscriber[];
  private registry = new Map<string, RegisteredBeacon>();
  /** Authoritative working copy of instance records; write-through to the adapter. */
  private instances = new Map<string, BeaconInstance>();
  private supervised = new Map<string, Supervised>();

  private signalAdapterName?: string;
  private signalAdapterOptions?: Record<string, unknown>;
  private signalAdapterImport?: string;

  private running = false;
  private stopping = false;
  private ticking = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollResolve: (() => void) | null = null;

  constructor(options: BeaconRunnerOptions = {}) {
    this.adapter = options.adapter ?? new BeaconMemoryAdapter();
    this.beaconsDir = options.beaconsDir;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.subscribers = options.subscribers ? [...options.subscribers] : [];

    const signalAdapter = options.signalAdapter ?? options.signalRunner?.getAdapter();
    if (signalAdapter && isSerializableAdapter(signalAdapter)) {
      const manifest = signalAdapter.toManifest();
      this.signalAdapterName = manifest.name;
      this.signalAdapterOptions = manifest.options;
      this.signalAdapterImport = manifest.moduleUrl;
    }
  }

  static create(
    beaconsDir: string,
    options: Omit<BeaconRunnerOptions, "beaconsDir"> = {},
  ): BeaconRunner {
    return new BeaconRunner({ ...options, beaconsDir });
  }

  // ─── Registration / discovery ──────────────────────────────────────

  /** Register a beacon explicitly (alternative to auto-discovery). */
  register(beacon: AnyBeacon, filePath: string): this {
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
    autoStart: boolean;
  }> {
    return Array.from(this.registry.values()).map(({ beacon, filePath }) => ({
      name: beacon.name,
      filePath,
      mode: beacon.mode,
      restartPolicy: beacon.restartPolicy,
      autoStart: beacon.autoStart,
    }));
  }

  hasBeacon(name: string): boolean {
    return this.registry.has(name);
  }

  getBeacon(name: string): AnyBeacon | undefined {
    return this.registry.get(name)?.beacon;
  }

  /** Current instance record for a beacon (status, desired state, counters). */
  async getInstance(name: string): Promise<BeaconInstance | null> {
    return this.instances.get(name) ?? this.adapter.getInstance(name);
  }

  /** All known instance records. */
  async listInstances(): Promise<BeaconInstance[]> {
    return Array.from(this.instances.values()).map((i) => ({ ...i }));
  }

  private async discover(dir: string): Promise<void> {
    let files: string[];
    try {
      const entries = await readdir(dir, { recursive: true });
      files = entries
        .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
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

    if (this.beaconsDir) {
      await this.discover(resolve(this.beaconsDir));
    }

    // Seed or resume instance records for every registered beacon.
    for (const { beacon } of this.registry.values()) {
      await this.seedOrResume(beacon);
    }

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
      for (const [name, sup] of this.supervised) {
        if (sup.child) this.initiateStop(name);
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

  // ─── Operator controls ─────────────────────────────────────────────

  /**
   * Start a beacon (or ensure it's running). Sets desired state to running and
   * schedules an immediate launch. Optionally overrides its config.
   */
  async startBeacon(name: string, opts?: { config?: unknown }): Promise<void> {
    const reg = this.registry.get(name);
    if (!reg) throw new Error(`Beacon "${name}" is not registered`);
    if (!this.instances.has(name)) await this.seedOrResume(reg.beacon);

    const patch: BeaconInstancePatch = { desiredState: "running" };
    if (opts && "config" in opts) {
      patch.config = opts.config !== undefined ? JSON.stringify(opts.config) : undefined;
    }
    // If nothing is live, schedule an immediate (re)start and clear any error.
    if (!this.supervised.get(name)?.child) {
      patch.status = "backoff";
      patch.nextRestartAt = new Date();
      patch.restartCount = 0;
      patch.lastError = undefined;
    }
    await this.patch(name, patch);
  }

  /** Stop a beacon and keep it stopped (desired state = stopped). */
  async stopBeacon(name: string): Promise<void> {
    const inst = this.instances.get(name);
    if (!inst) return;
    await this.patch(name, { desiredState: "stopped" });
    const sup = this.supervised.get(name);
    if (sup?.child && !sup.stopRequested) {
      this.initiateStop(name);
    } else if (inst.status === "backoff") {
      await this.patch(name, { status: "stopped", nextRestartAt: undefined });
    }
  }

  /** Restart a beacon now — graceful stop of the current incarnation, then relaunch. */
  async restartBeacon(name: string): Promise<void> {
    const sup = this.supervised.get(name);
    if (sup?.child) {
      sup.forceRestart = true;
      await this.patch(name, { desiredState: "running" });
      this.initiateStop(name);
    } else {
      await this.startBeacon(name);
    }
  }

  // ─── Seeding / reconciliation ──────────────────────────────────────

  private async seedOrResume(beacon: AnyBeacon): Promise<void> {
    const existing = await this.adapter.getInstance(beacon.name);
    if (existing) {
      // Resume: on boot no child is live, so any desired-running beacon is
      // rescheduled to launch; desired-stopped ones stay put.
      this.instances.set(beacon.name, existing);
      if (existing.desiredState === "running") {
        await this.patch(beacon.name, {
          status: "backoff",
          nextRestartAt: new Date(),
          restartCount: 0,
          pid: undefined,
        });
      }
      this.supervised.set(beacon.name, this.freshSupervised());
      return;
    }

    const now = new Date();
    const instance: BeaconInstance = {
      beaconName: beacon.name,
      status: beacon.autoStart ? "backoff" : "stopped",
      desiredState: beacon.autoStart ? "running" : "stopped",
      incarnation: 0,
      restartCount: 0,
      config: beacon.defaultConfig !== undefined ? JSON.stringify(beacon.defaultConfig) : undefined,
      nextRestartAt: beacon.autoStart ? now : undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.instances.set(beacon.name, instance);
    this.supervised.set(beacon.name, this.freshSupervised());
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
      for (const { beacon } of this.registry.values()) {
        await this.reconcile(beacon, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async reconcile(beacon: AnyBeacon, now: number): Promise<void> {
    if (this.stopping) return;
    const inst = this.instances.get(beacon.name);
    if (!inst) return;
    const sup = this.supervised.get(beacon.name)!;

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
        this.emit("onBeaconStalled", { instance: { ...inst } });
        await this.addEvent(beacon.name, inst.incarnation, "stalled");
        this.initiateStop(beacon.name);
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
      await this.spawnBeacon(beacon);
    }
  }

  // ─── Spawn ─────────────────────────────────────────────────────────

  private async spawnBeacon(beacon: AnyBeacon): Promise<void> {
    const reg = this.registry.get(beacon.name)!;
    const inst = this.instances.get(beacon.name)!;
    const incarnation = inst.incarnation + 1;

    await this.patch(beacon.name, {
      status: "starting",
      incarnation,
      startedAt: new Date(),
      readyAt: undefined,
      nextRestartAt: undefined,
    });
    this.emit("onBeaconStarting", { instance: { ...this.instances.get(beacon.name)! } });
    await this.addEvent(beacon.name, incarnation, "starting");

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      STATION_BEACON_NAME: beacon.name,
      STATION_BEACON_FILE: reg.filePath,
      STATION_BEACON_INCARNATION: String(incarnation),
      STATION_BEACON_CONFIG: inst.config ?? "{}",
      STATION_BEACON_STOP_TIMEOUT: String(beacon.stopTimeoutMs),
    };
    if (this.signalAdapterName) {
      env.STATION_SIGNAL_ADAPTER = this.signalAdapterName;
      if (this.signalAdapterOptions) {
        env.STATION_SIGNAL_ADAPTER_OPTIONS = JSON.stringify(this.signalAdapterOptions);
      }
      if (this.signalAdapterImport) {
        env.STATION_SIGNAL_ADAPTER_IMPORT = this.signalAdapterImport;
      }
    }

    // A stop may have been requested while we prepared to launch. Bail before
    // spawning so we never leave a child the stop sweep has already passed.
    if (this.stopping) return;

    const tsxImport = getTsxImport();
    const nodeArgs = tsxImport ? ["--import", tsxImport, BOOTSTRAP] : [BOOTSTRAP];
    const child = spawn("node", nodeArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
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
    this.supervised.set(beacon.name, sup);
    await this.patch(beacon.name, { pid: child.pid });

    child.on("message", (msg: BeaconIPCMessage) => {
      this.handleMessage(beacon, msg).catch((err) =>
        console.error(`[station-beacon] message handler error for "${beacon.name}":`, err),
      );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      this.emit("onBeaconLog", {
        instance: { ...this.instances.get(beacon.name)! },
        level: "stdout",
        message: chunk.toString(),
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.emit("onBeaconLog", {
        instance: { ...this.instances.get(beacon.name)! },
        level: "stderr",
        message: chunk.toString(),
      });
    });
    child.on("error", (err) => {
      console.error(`[station-beacon] Failed to spawn "${beacon.name}":`, err);
      void this.handleExit(beacon, null, err.message);
    });
    child.on("exit", (code) => {
      void this.handleExit(beacon, code);
    });
  }

  private async handleMessage(beacon: AnyBeacon, msg: BeaconIPCMessage): Promise<void> {
    const sup = this.supervised.get(beacon.name);
    if (!sup) return;
    switch (msg.type) {
      case "beacon:started": {
        sup.runningSinceMs = Date.now();
        if (!sup.stopRequested) {
          await this.patch(beacon.name, { status: "running" });
        }
        this.emit("onBeaconStarted", { instance: { ...this.instances.get(beacon.name)! } });
        break;
      }
      case "beacon:ready": {
        await this.patch(beacon.name, { readyAt: new Date() });
        this.emit("onBeaconReady", { instance: { ...this.instances.get(beacon.name)! } });
        await this.addEvent(beacon.name, msg.incarnation, "ready");
        break;
      }
      case "beacon:heartbeat": {
        sup.lastHeartbeatMs = Date.now();
        await this.patch(beacon.name, { lastHeartbeatAt: new Date() });
        this.emit("onBeaconHeartbeat", { instance: { ...this.instances.get(beacon.name)! } });
        break;
      }
      case "beacon:error": {
        const error = (msg.data?.error as string) ?? "Unknown error";
        await this.patch(beacon.name, { lastError: error });
        if (msg.data?.fatal) {
          // Config/definition errors are fatal — mark for terminal errored state.
          sup.forceRestart = false;
          sup.fatal = true;
        }
        break;
      }
      case "beacon:log": {
        this.emit("onBeaconLog", {
          instance: { ...this.instances.get(beacon.name)! },
          level: "log",
          message: (msg.data?.message as string) ?? "",
        });
        break;
      }
      case "beacon:stopping":
        break;
    }
  }

  // ─── Exit handling ─────────────────────────────────────────────────

  private async handleExit(beacon: AnyBeacon, code: number | null, spawnError?: string): Promise<void> {
    const sup = this.supervised.get(beacon.name);
    if (!sup || sup.exitHandled) return;
    sup.exitHandled = true;

    if (sup.killTimer) {
      clearTimeout(sup.killTimer);
      sup.killTimer = undefined;
    }
    const uptimeMs = sup.startedAtMs ? Date.now() - sup.startedAtMs : 0;
    const child = sup.child;
    sup.child = undefined;

    const reason: ExitReason = sup.stalled
      ? "stalled"
      : sup.stopRequested
        ? "stopped"
        : code === 0
          ? "clean"
          : "failure";

    const inst = this.instances.get(beacon.name)!;
    await this.patch(beacon.name, {
      pid: undefined,
      readyAt: undefined,
      lastExitAt: new Date(),
      lastExitReason: reason,
      ...(spawnError ? { lastError: spawnError } : {}),
    });
    this.emit("onBeaconExited", { instance: { ...this.instances.get(beacon.name)! }, reason, code });
    await this.addEvent(beacon.name, inst.incarnation, "exited", `reason=${reason} code=${code ?? "null"}`);
    child?.removeAllListeners();

    // Forced restart (operator restart) takes precedence and ignores policy.
    if (sup.forceRestart && !this.stopping) {
      await this.scheduleRestart(beacon, 0, 0);
      return;
    }

    // Fatal error (bad config / missing beacon) → terminal, never restart.
    if (sup.fatal) {
      await this.patch(beacon.name, { status: "errored" });
      this.emit("onBeaconErrored", {
        instance: { ...this.instances.get(beacon.name)! },
        error: inst.lastError,
      });
      await this.addEvent(beacon.name, inst.incarnation, "errored", inst.lastError);
      return;
    }

    const willRestart =
      !this.stopping && shouldRestart(beacon.restartPolicy, reason, inst.desiredState);

    if (willRestart) {
      const attempt = shouldResetBackoff(uptimeMs, beacon.backoff) ? 0 : inst.restartCount;
      const delay = computeBackoffMs(attempt, beacon.backoff);
      await this.scheduleRestart(beacon, delay, attempt + 1);
      return;
    }

    // No restart. Distinguish a terminal failure from a completed/stopped beacon.
    if (reason === "failure" || reason === "stalled") {
      await this.patch(beacon.name, { status: "errored" });
      this.emit("onBeaconErrored", {
        instance: { ...this.instances.get(beacon.name)! },
        error: inst.lastError,
      });
      await this.addEvent(beacon.name, inst.incarnation, "errored", inst.lastError);
    } else {
      // clean self-completion: mark desired stopped so we don't relaunch it.
      const patch: BeaconInstancePatch = { status: "stopped" };
      if (reason === "clean") patch.desiredState = "stopped";
      await this.patch(beacon.name, patch);
      this.emit("onBeaconStopped", { instance: { ...this.instances.get(beacon.name)! } });
      await this.addEvent(beacon.name, inst.incarnation, "stopped");
    }
  }

  private async scheduleRestart(beacon: AnyBeacon, delayMs: number, restartCount: number): Promise<void> {
    const nextRestartAt = new Date(Date.now() + delayMs);
    await this.patch(beacon.name, {
      status: "backoff",
      restartCount,
      nextRestartAt,
    });
    // Reset volatile state for the next incarnation.
    this.supervised.set(beacon.name, this.freshSupervised());
    this.emit("onBeaconRestartScheduled", {
      instance: { ...this.instances.get(beacon.name)! },
      delayMs,
      nextRestartAt,
    });
    await this.addEvent(
      beacon.name,
      this.instances.get(beacon.name)!.incarnation,
      "restart-scheduled",
      `in ${delayMs}ms`,
    );
  }

  /**
   * Request a graceful stop over IPC (falling back to SIGTERM), and arm a
   * SIGKILL escalation timer at the beacon's stop timeout so a handler that
   * ignores the stop can't hang the supervisor.
   */
  private initiateStop(name: string): void {
    const sup = this.supervised.get(name);
    const beacon = this.registry.get(name)?.beacon;
    if (!sup?.child || sup.stopRequested) return;
    sup.stopRequested = true;
    void this.patch(name, { status: "stopping" });
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

  private async patch(name: string, patch: BeaconInstancePatch): Promise<void> {
    const inst = this.instances.get(name);
    if (!inst) return;
    Object.assign(inst, patch);
    inst.updatedAt = new Date();
    this.instances.set(name, inst);
    try {
      await this.adapter.updateInstance(name, { ...patch, updatedAt: inst.updatedAt });
    } catch (err) {
      console.error(`[station-beacon] Failed to persist instance "${name}":`, err);
    }
  }

  private async addEvent(
    beaconName: string,
    incarnation: number,
    type: Parameters<NonNullable<BeaconStateAdapter["addEvent"]>>[0]["type"],
    message?: string,
  ): Promise<void> {
    if (!this.adapter.addEvent) return;
    try {
      await this.adapter.addEvent({
        id: this.adapter.generateId(),
        beaconName,
        incarnation,
        type,
        message,
        at: new Date(),
      });
    } catch (err) {
      console.error(`[station-beacon] Failed to record event for "${beaconName}":`, err);
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
        res();
      }, ms);
    });
  }
}
