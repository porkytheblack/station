import { type ChildProcess, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSerializableAdapter, type SignalQueueAdapter } from "./adapters/index.js";
import { MemoryAdapter } from "./adapters/memory.js";
import { configure, onLocalEnqueue } from "./config.js";
import { parseInterval } from "./interval.js";
import type { AnySignal } from "./signal.js";
import type { IPCMessage, JobInitMessage, SignalSubscriber } from "./subscribers/index.js";
import { ConsoleSubscriber } from "./subscribers/console.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  type ListAllRunsOptions,
  type ListRunsOptions,
  type Run,
  type RunStatus,
  type Step,
} from "./types.js";
import { isSignal } from "./util.js";

const BOOTSTRAP = fileURLToPath(new URL("./bootstrap.js", import.meta.url));

let _tsxImport: string | undefined;
function getTsxImport(): string | undefined {
  if (_tsxImport !== undefined) return _tsxImport || undefined;
  // Allow station-kit (or other launchers) to pass the tsx path
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

interface RegisteredSignal {
  name: string;
  filePath: string;
  maxConcurrency?: number;
  /**
   * The actual Signal object — set when discovered via `discover()` or
   * registered via `registerSignal()`. Allows callers (e.g. dynamic broadcasts)
   * to access `inputSchema`, `outputSchema`, and `trigger()` without re-importing.
   */
  signal?: AnySignal;
}

interface RecurringSchedule {
  signalName: string;
  filePath: string;
  interval: string;
  /** Parsed once at registration — parsing per tick is wasted work. */
  intervalMs: number;
  nextRunAt: Date;
  timeout: number;
  maxAttempts: number;
  input?: string;
}

/**
 * Minimal interface a schedule reconciler needs from the runner. Decoupled
 * so `station-signal` doesn't depend on `station-schedules`.
 */
export interface SignalScheduleReconciler {
  tick(): Promise<void>;
}

/**
 * Source of runtime-managed env vars for signal/beacon runs. Decoupled so
 * `station-signal` doesn't depend on `station-env` — the `EnvStore` from
 * `station-env` satisfies this structurally.
 */
export interface EnvProvider {
  /** The env map to inject into a run of the given target. */
  resolveFor(target: { kind: "signal" | "beacon"; name: string }): Promise<Record<string, string>>;
}

export interface SignalRunnerOptions {
  signalsDir?: string;
  adapter?: SignalQueueAdapter;
  pollIntervalMs?: number;
  /**
   * Maximum poll interval when idle. After a tick that finds no due runs and
   * has no active children, the runner doubles its poll interval up to this
   * cap, and resets to `pollIntervalMs` as soon as there is work. In-process
   * triggers wake the runner immediately, so this only adds latency for runs
   * enqueued by *other* processes into a shared adapter.
   * Set equal to `pollIntervalMs` to disable idle back-off.
   * @default max(pollIntervalMs, 5000)
   */
  idlePollIntervalMs?: number;
  /** Default max attempts for signals that don't specify their own. */
  maxAttempts?: number;
  /** Subscribers notified of signal lifecycle events. */
  subscribers?: SignalSubscriber[];
  /** Maximum number of concurrent child processes. @default 5 */
  maxConcurrent?: number;
  /** Base delay (ms) for exponential retry backoff. @default 1000 */
  retryBackoffMs?: number;
  /**
   * Optional dynamic schedule reconciler. When set, the runner ticks it on
   * the same cadence as run discovery. Wire `station-schedules` here.
   */
  scheduleReconciler?: SignalScheduleReconciler;
  /**
   * Optional source of runtime-managed env vars (wire `station-env`'s
   * `EnvStore` here). Resolved vars are sent to the child over IPC and
   * applied to its process.env before the signal file is imported; they are
   * also what satisfies `.env()` requirements, alongside the host process env.
   */
  envProvider?: EnvProvider;
}

export class SignalRunner {
  private adapter: SignalQueueAdapter;
  private pollIntervalMs: number;
  private signalsDir?: string;
  private adapterName?: string;
  private adapterOptions?: Record<string, unknown>;
  private adapterImport?: string;
  private defaultMaxAttempts: number;
  private retryBackoffMs: number;
  private registry = new Map<string, RegisteredSignal>();
  private recurringSchedules = new Map<string, RecurringSchedule>();
  private subscribers: SignalSubscriber[];
  private maxConcurrent: number;
  private scheduleReconciler?: SignalScheduleReconciler;
  private envProvider?: EnvProvider;
  private activeCount = 0;
  private activePerSignal = new Map<string, number>();
  /** Map runId → child process for cancel/timeout kill. */
  private childByRunId = new Map<string, ChildProcess>();
  private running = false;
  private stopping = false;
  private ticking = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private idlePollIntervalMs: number;
  private currentPollMs: number;
  private wake: (() => void) | null = null;
  private lastRunningSweepAt = 0;
  /** How often to scan for orphaned "running" runs when we own no children. */
  private static readonly ORPHAN_SWEEP_INTERVAL_MS = 30_000;

  constructor(options: SignalRunnerOptions = {}) {
    const adapter = options.adapter ?? new MemoryAdapter();
    configure({ adapter });
    this.adapter = adapter;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.idlePollIntervalMs = Math.max(
      options.idlePollIntervalMs ?? Math.max(this.pollIntervalMs, 5000),
      this.pollIntervalMs,
    );
    this.currentPollMs = this.pollIntervalMs;
    this.signalsDir = options.signalsDir;

    if (isSerializableAdapter(adapter)) {
      const manifest = adapter.toManifest();
      this.adapterName = manifest.name;
      this.adapterOptions = manifest.options;
      this.adapterImport = manifest.moduleUrl;
    }

    this.defaultMaxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBackoffMs = options.retryBackoffMs ?? 1000;
    this.subscribers = options.subscribers ? [...options.subscribers] : [];
    this.maxConcurrent = options.maxConcurrent ?? 5;
    this.scheduleReconciler = options.scheduleReconciler;
    this.envProvider = options.envProvider;
  }

  /**
   * Trigger a registered signal by name, writing to **this runner's** adapter.
   * Used by the schedule reconciler so dynamic schedules don't depend on the
   * global `configure()` singleton — important when multiple SignalRunner
   * instances coexist or when the global adapter differs from this runner's.
   */
  async triggerSignal(name: string, input: unknown): Promise<string> {
    const sig = this.registry.get(name)?.signal;
    if (!sig) {
      throw new Error(`Signal "${name}" is not registered (no Signal object available)`);
    }
    // Validate via the signal's Zod schema so bad input fails fast, then
    // write directly to this runner's adapter rather than through getAdapter().
    const result = sig.inputSchema.safeParse(input);
    if (!result.success) {
      throw new Error(`Invalid input for signal "${name}": ${result.error.message}`);
    }
    const id = this.adapter.generateId();
    const run: Run = {
      id,
      signalName: name,
      kind: "trigger",
      input: JSON.stringify(result.data),
      status: "pending",
      attempts: 0,
      maxAttempts: sig.maxAttempts,
      timeout: sig.timeout,
      createdAt: new Date(),
    };
    await this.adapter.addRun(run);
    this.wakeUp();
    return id;
  }

  hasPendingOrRunningForSignal(name: string): Promise<boolean> {
    return this.adapter.hasRunWithStatus(name, ["pending", "running"]);
  }

  /** The underlying queue adapter. Useful for broadcast orchestration and advanced queries. */
  getAdapter(): SignalQueueAdapter {
    return this.adapter;
  }

  static create(signalsDir: string, options: Omit<SignalRunnerOptions, "signalsDir"> = {}): SignalRunner {
    const subscribers = options.subscribers ?? [new ConsoleSubscriber()];
    return new SignalRunner({ ...options, signalsDir, subscribers });
  }

  /** List all registered signals with metadata. */
  listRegistered(): Array<{ name: string; filePath: string; maxConcurrency?: number; requiredEnv?: string[] }> {
    return Array.from(this.registry.values()).map(({ name, filePath, maxConcurrency, signal }) => ({
      name, filePath, maxConcurrency, requiredEnv: signal?.requiredEnv,
    }));
  }

  /** Check whether a signal is registered by name. */
  hasSignal(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Return the Signal object for a registered name, when available. Discovered
   * signals always populate this; signals registered via `register(name, filePath)`
   * only do so if the file is later loaded.
   */
  getSignal(name: string): AnySignal | undefined {
    return this.registry.get(name)?.signal;
  }

  /** All Signal objects this runner has loaded, keyed by name. */
  getAllSignals(): Map<string, AnySignal> {
    const out = new Map<string, AnySignal>();
    for (const entry of this.registry.values()) {
      if (entry.signal) out.set(entry.name, entry.signal);
    }
    return out;
  }

  register(name: string, filePath: string, options?: { maxConcurrency?: number }): this {
    this.registry.set(name, { name, filePath: resolve(filePath), maxConcurrency: options?.maxConcurrency });
    return this;
  }

  /** Register a Signal object directly. */
  registerSignal(signal: AnySignal, filePath: string): this {
    this.registry.set(signal.name, {
      name: signal.name,
      filePath: resolve(filePath),
      maxConcurrency: signal.maxConcurrency,
      signal,
    });
    return this;
  }

  subscribe(subscriber: SignalSubscriber): this {
    this.subscribers.push(subscriber);
    return this;
  }

  /** Get a run by ID. */
  async getRun(id: string): Promise<Run | null> {
    return this.adapter.getRun(id);
  }

  /** List runs for a signal. Pass `options` to page/filter; omit for full history. */
  async listRuns(signalName: string, options?: ListRunsOptions): Promise<Run[]> {
    return this.adapter.listRuns(signalName, options);
  }

  /** List runs across all signals (or one, via `options.signalName`), newest-first. */
  async listAllRuns(options?: ListAllRunsOptions): Promise<Run[]> {
    return this.adapter.listAllRuns(options);
  }

  /** Count runs grouped by status (optionally for one signal). */
  async countRunsByStatus(options?: { signalName?: string }): Promise<Partial<Record<RunStatus, number>>> {
    return this.adapter.countRunsByStatus(options);
  }

  /** Get steps for a run. */
  async getSteps(runId: string): Promise<Step[]> {
    return this.adapter.getSteps(runId);
  }

  /**
   * Wait for a run to reach a terminal status (completed, failed, cancelled).
   * If the run does not exist yet and `waitForExistence` is true, polls until it appears.
   */
  async waitForRun(runId: string, opts?: { pollMs?: number; timeoutMs?: number; waitForExistence?: boolean }): Promise<Run | null> {
    const pollMs = opts?.pollMs ?? 200;
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const waitForExistence = opts?.waitForExistence ?? false;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const run = await this.adapter.getRun(runId);
      if (!run) {
        if (!waitForExistence) return null;
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        return run;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return this.adapter.getRun(runId);
  }

  /** Purge completed/failed/cancelled runs older than the given age. */
  async purgeCompleted(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this.adapter.purgeRuns(cutoff, ["completed", "failed", "cancelled"]);
  }

  private emit<K extends keyof SignalSubscriber>(
    event: K,
    data: Parameters<NonNullable<SignalSubscriber[K]>>[0],
  ): void {
    for (const sub of this.subscribers) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sub[event] as any)?.(data);
      } catch (err) {
        console.error(`[station-signal] Subscriber error in ${String(event)}:`, err);
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("[station-signal] Runner is already started");
    }

    if (this.signalsDir) {
      await this.discover(resolve(this.signalsDir));
    }

    // M5: Install default SIGINT/SIGTERM handlers for graceful shutdown
    const shutdown = () => {
      console.log("[station-signal] Received shutdown signal, stopping...");
      this.stop({ graceful: true, timeoutMs: 10_000 }).catch((err) => {
        console.error("[station-signal] Error during shutdown:", err);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    // Wake from idle back-off immediately when a run is enqueued in-process
    // (e.g. `signal.trigger()` writing through the global adapter).
    const unsubscribeWake = onLocalEnqueue(() => this.wakeUp());

    this.running = true;
    while (this.running) {
      let busy = true;
      try {
        busy = await this.tick();
      } catch (err) {
        console.error("[station-signal] tick() failed:", err);
      }
      if (!this.running) break;
      await this.sleep(this.nextDelay(busy));
    }

    unsubscribeWake();
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  /**
   * Compute how long to sleep before the next tick. Busy ticks poll at the
   * base cadence; idle ticks back off exponentially up to `idlePollIntervalMs`
   * so an idle runner costs (almost) nothing in CPU and adapter queries.
   * The delay never sleeps past the next due recurring schedule.
   */
  private nextDelay(busy: boolean): number {
    if (busy) {
      this.currentPollMs = this.pollIntervalMs;
    } else {
      this.currentPollMs = Math.min(this.currentPollMs * 2, this.idlePollIntervalMs);
    }

    let delay = this.currentPollMs;
    if (delay > this.pollIntervalMs) {
      const now = Date.now();
      for (const schedule of this.recurringSchedules.values()) {
        const until = schedule.nextRunAt.getTime() - now;
        if (until < delay) delay = until;
      }
      delay = Math.max(delay, this.pollIntervalMs);
    }
    return delay;
  }

  /** Stop the runner and optionally wait for active children to exit. */
  async stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    // Resolve any in-flight sleep so the start() loop exits promptly.
    this.wake?.();

    if (options?.graceful && this.childByRunId.size > 0) {
      const timeout = options.timeoutMs ?? 10_000;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      await this.waitForChildren(ac.signal);
      clearTimeout(timer);

      // Kill any remaining children after timeout
      for (const child of this.childByRunId.values()) {
        child.kill("SIGTERM");
      }
    }

    // Close the adapter to release resources (e.g. database connections)
    try {
      await this.adapter.close?.();
    } catch (err) {
      console.error("[station-signal] Error closing adapter:", err);
    }
  }

  /** Cancel a specific run. Marks it as cancelled and kills the child process. */
  async cancel(runId: string): Promise<boolean> {
    const run = await this.adapter.getRun(runId);
    if (!run) return false;

    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return false;
    }

    await this.adapter.updateRun(runId, {
      status: "cancelled",
      completedAt: new Date(),
    });

    // Kill the child process if running
    const child = this.childByRunId.get(runId);
    if (child) {
      child.kill("SIGTERM");
    }

    this.emit("onRunCancelled", { run });
    return true;
  }

  private waitForChildren(abortSignal: AbortSignal): Promise<void> {
    if (this.childByRunId.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (this.childByRunId.size === 0 || abortSignal.aborted) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
      abortSignal.addEventListener("abort", () => {
        clearInterval(interval);
        resolve();
      }, { once: true });
    });
  }

  private sleep(ms: number): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      const finish = () => {
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
        this.wake = null;
        res();
      };
      this.wake = finish;
      this.pollTimer = setTimeout(finish, ms);
    });
  }

  private wakePending = false;

  /**
   * Reset idle back-off and wake the poll loop. Safe to call at any time;
   * a wake that arrives mid-tick is remembered and consumed by the next sleep.
   */
  private wakeUp(): void {
    this.currentPollMs = this.pollIntervalMs;
    if (this.wake) {
      this.wake();
    } else if (this.running) {
      this.wakePending = true;
    }
  }

  private async discover(dir: string): Promise<void> {
    let files: string[];
    try {
      const entries = await readdir(dir, { recursive: true });
      files = entries
        .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts"))
        // Importing a file executes it — never auto-execute dependencies or
        // hidden files that happen to live under signalsDir.
        .filter((f) => {
          const parts = f.split(/[\\/]/);
          return !parts.some((p) => p === "node_modules" || p.startsWith("."));
        })
        .map((f) => join(dir, f));
    } catch {
      console.error(`[station-signal] Cannot read signalsDir: ${dir}`);
      return;
    }

    for (const filePath of files) {
      try {
        const mod = await import(filePath);
        for (const value of Object.values(mod)) {
          if (isSignal(value)) {
            // L11: Warn on duplicate signal names
            if (this.registry.has(value.name)) {
              console.warn(
                `[station-signal] Duplicate signal name "${value.name}" — overwriting with ${filePath}`,
              );
            }
            this.registry.set(value.name, {
              name: value.name,
              filePath,
              maxConcurrency: value.maxConcurrency,
              signal: value,
            });
            this.emit("onSignalDiscovered", { signalName: value.name, filePath });
            if (value.interval && !this.recurringSchedules.has(value.name)) {
              this.scheduleRecurring(value, filePath);
            }
          }
        }
      } catch (err) {
        console.warn(`[station-signal] Skipping ${filePath} — failed to import:`, err);
      }
    }
  }

  private scheduleRecurring(sig: AnySignal, filePath: string): void {
    const ms = parseInterval(sig.interval!);
    this.recurringSchedules.set(sig.name, {
      signalName: sig.name,
      filePath,
      interval: sig.interval!,
      intervalMs: ms,
      nextRunAt: new Date(Date.now() + ms),
      timeout: sig.timeout,
      maxAttempts: sig.maxAttempts,
      input: sig.recurringInput ? JSON.stringify(sig.recurringInput) : undefined,
    });
  }

  /** Returns true when this tick had work (used for idle back-off). */
  private async tick(): Promise<boolean> {
    if (this.ticking) return true;
    this.ticking = true;
    try {
    await this.checkTimeouts();
    await this.tickRecurring();
    if (this.scheduleReconciler) {
      try {
        await this.scheduleReconciler.tick();
      } catch (err) {
        console.error("[station-signal] Schedule reconciler error:", err);
      }
    }

    // Bounded batch: we dispatch at most `maxConcurrent` per tick, but some
    // due runs get skipped (per-signal concurrency, retry back-off), so fetch
    // a generous multiple rather than the whole (potentially huge) backlog.
    const dueBatch = Math.max(this.maxConcurrent * 5, 100);
    const due = await this.adapter.getRunsDue(dueBatch);
    for (const run of due) {
      if (this.activeCount >= this.maxConcurrent) break;

      const sig = this.registry.get(run.signalName);
      if (!sig) {
        const error = `No signal registered for "${run.signalName}"`;
        this.emit("onRunFailed", { run, error });
        await this.adapter.updateRun(run.id, {
          status: "failed",
          completedAt: new Date(),
          error,
        });
        continue;
      }

      // Per-signal concurrency check
      if (sig.maxConcurrency !== undefined) {
        const activeForSignal = this.activePerSignal.get(run.signalName) ?? 0;
        if (activeForSignal >= sig.maxConcurrency) {
          this.emit("onRunSkipped", {
            run,
            reason: `Concurrency limit (${sig.maxConcurrency}) reached for "${run.signalName}"`,
          });
          continue;
        }
      }

      // Check retry backoff
      if (run.attempts > 0 && run.lastRunAt) {
        const backoffMs = this.retryBackoffMs * Math.pow(2, run.attempts - 1);
        const elapsed = Date.now() - run.lastRunAt.getTime();
        if (elapsed < backoffMs) continue;
      }

      // Resolve store-managed env vars and enforce `.env()` requirements
      // before spending a child process on a run that cannot succeed.
      let injectedEnv: Record<string, string> | undefined;
      if (this.envProvider) {
        try {
          injectedEnv = await this.envProvider.resolveFor({ kind: "signal", name: run.signalName });
        } catch (err) {
          console.error(`[station-signal] Env provider failed for "${run.signalName}":`, err);
        }
      }
      const requiredEnv = sig.signal?.requiredEnv;
      if (requiredEnv && requiredEnv.length > 0) {
        const missing = requiredEnv.filter(
          (key) => !(injectedEnv && key in injectedEnv) && process.env[key] === undefined,
        );
        if (missing.length > 0) {
          const error =
            `Missing required environment variable${missing.length > 1 ? "s" : ""} for "${run.signalName}": ` +
            `${missing.join(", ")}. Define ${missing.length > 1 ? "them" : "it"} in the Station env store or the host environment.`;
          this.emit("onRunFailed", { run, error });
          await this.adapter.updateRun(run.id, {
            status: "failed",
            completedAt: new Date(),
            error,
          });
          continue;
        }
      }

      // Mark as running — runner is single authority for run status (H1)
      await this.adapter.updateRun(run.id, {
        status: "running",
        startedAt: new Date(),
        lastRunAt: new Date(),
        attempts: run.attempts + 1,
      });

      const freshRun = await this.adapter.getRun(run.id);
      this.activeCount++;
      this.incrementPerSignal(run.signalName);
      const dispatchRun = freshRun ?? run;
      this.emit("onRunDispatched", { run: dispatchRun });
      this.dispatch(sig, dispatchRun, injectedEnv);
    }
    // Busy while there are due runs (including ones waiting out retry
    // back-off) or children still executing — keep the base poll cadence.
    return due.length > 0 || this.childByRunId.size > 0;
    } finally {
      this.ticking = false;
    }
  }

  private async tickRecurring(): Promise<void> {
    const now = new Date();
    for (const [name, schedule] of this.recurringSchedules) {
      if (schedule.nextRunAt > now) continue;

      // M7: Skip if a pending or running run already exists for this signal
      const hasPendingOrRunning = await this.adapter.hasRunWithStatus(name, ["pending", "running"]);
      if (hasPendingOrRunning) {
        // Advance schedule anyway to prevent tight-loop re-checks
        schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs);
        continue;
      }

      const id = this.adapter.generateId();
      const run: Run = {
        id,
        signalName: name,
        kind: "recurring",
        input: schedule.input ?? JSON.stringify({}),
        status: "pending",
        attempts: 0,
        maxAttempts: schedule.maxAttempts,
        timeout: schedule.timeout,
        interval: schedule.interval,
        createdAt: new Date(),
      };
      await this.adapter.addRun(run);

      schedule.nextRunAt = new Date(Date.now() + schedule.intervalMs);

      this.emit("onRunRescheduled", { run, nextRunAt: schedule.nextRunAt });
    }
  }

  private async checkTimeouts(): Promise<void> {
    // When this runner owns no child processes, the only "running" runs that
    // could exist are orphans from a crashed process — sweep for those on a
    // slow cadence instead of querying the adapter every tick.
    const now = Date.now();
    if (
      this.childByRunId.size === 0 &&
      now - this.lastRunningSweepAt < SignalRunner.ORPHAN_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    this.lastRunningSweepAt = now;

    const running = await this.adapter.getRunsRunning();

    for (const run of running) {
      if (!run.startedAt) continue;

      const elapsed = Date.now() - run.startedAt.getTime();
      if (elapsed < run.timeout) continue;

      // Kill the child process
      const child = this.childByRunId.get(run.id);
      if (child) {
        child.kill("SIGTERM");
      }

      // Re-read run status after kill — IPC may have already resolved it (H1)
      const current = await this.adapter.getRun(run.id);
      if (!current || current.status !== "running") continue;

      const maxAttempts = current.maxAttempts ?? this.defaultMaxAttempts;

      this.emit("onRunTimeout", { run: current });

      const error = `Timed out after ${current.timeout}ms`;
      if (current.attempts < maxAttempts) {
        await this.adapter.updateRun(run.id, {
          status: "pending",
          startedAt: undefined,
          lastRunAt: new Date(),
          error,
        });
        this.emit("onRunRetry", { run: current, attempt: current.attempts, maxAttempts });
      } else {
        await this.adapter.updateRun(run.id, {
          status: "failed",
          completedAt: new Date(),
          error: `${error} (${maxAttempts} attempts exhausted)`,
        });
        this.emit("onRunFailed", { run: current, error });
      }
    }
  }

  private incrementPerSignal(signalName: string): void {
    this.activePerSignal.set(signalName, (this.activePerSignal.get(signalName) ?? 0) + 1);
  }

  private decrementPerSignal(signalName: string): void {
    const current = this.activePerSignal.get(signalName) ?? 0;
    if (current <= 1) {
      this.activePerSignal.delete(signalName);
    } else {
      this.activePerSignal.set(signalName, current - 1);
    }
  }

  private dispatch(sig: RegisteredSignal, run: Run, injectedEnv?: Record<string, string>): void {
    // Only non-sensitive identifiers go through the environment (visible via
    // /proc/<pid>/environ to any same-user process). The run input, signal
    // file path, adapter config, and store-managed env vars — which may
    // contain credentials — are sent over the private IPC channel instead
    // (see job:init below).
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      STATION_SIGNAL_NAME: run.signalName,
      STATION_SIGNAL_RUN_ID: run.id,
      STATION_SIGNAL_TIMEOUT: String(run.timeout ?? DEFAULT_TIMEOUT_MS),
    };

    const tsxImport = getTsxImport();
    const nodeArgs = tsxImport ? ["--import", tsxImport, BOOTSTRAP] : [BOOTSTRAP];
    const child = spawn("node", nodeArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    const init: JobInitMessage = {
      type: "job:init",
      data: {
        runId: run.id,
        signalName: run.signalName,
        signalFile: sig.filePath,
        input: run.input,
        adapterName: this.adapterName,
        adapterOptions: this.adapterOptions,
        adapterImport: this.adapterImport,
        env: injectedEnv && Object.keys(injectedEnv).length > 0 ? injectedEnv : undefined,
      },
    };
    try {
      child.send(init);
    } catch (err) {
      console.error(`[station-signal] Failed to send job to child for "${sig.name}":`, err);
    }

    this.childByRunId.set(run.id, child);
    let resolved = false;

    const cleanup = () => {
      this.childByRunId.delete(run.id);
    };

    child.on("message", async (msg: IPCMessage) => {
      switch (msg.type) {
        case "run:started": {
          const current = await this.adapter.getRun(run.id);
          this.emit("onRunStarted", { run: current ?? run });
          break;
        }
        case "run:completed": {
          // Set resolved BEFORE any await (H5)
          resolved = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.decrementPerSignal(run.signalName);
          cleanup();

          const output = msg.data?.output as string | undefined;

          // Check run wasn't already cancelled/failed by timeout
          const current = await this.adapter.getRun(run.id);
          if (current && (current.status === "cancelled" || current.status === "failed")) {
            break; // Don't overwrite
          }

          await this.adapter.updateRun(run.id, { status: "completed", completedAt: new Date(), output });
          this.emit("onRunCompleted", { run: current ?? run, output });
          break;
        }
        case "run:failed": {
          resolved = true;
          this.activeCount = Math.max(0, this.activeCount - 1);
          this.decrementPerSignal(run.signalName);
          cleanup();

          const error = (msg.data?.error as string) ?? undefined;
          const retryable = msg.data?.retryable !== false;

          // Check run wasn't already cancelled/failed by timeout
          const currentRun = await this.adapter.getRun(run.id);
          if (currentRun && (currentRun.status === "cancelled" || currentRun.status === "failed")) {
            break;
          }

          const attempts = currentRun?.attempts ?? run.attempts;
          const maxAttempts = run.maxAttempts ?? this.defaultMaxAttempts;

          if (retryable && attempts < maxAttempts) {
            await this.adapter.updateRun(run.id, {
              status: "pending",
              startedAt: undefined,
              lastRunAt: new Date(),
              error,
            });
            this.emit("onRunRetry", { run: currentRun ?? run, attempt: attempts, maxAttempts });
          } else {
            await this.adapter.updateRun(run.id, { status: "failed", completedAt: new Date(), error });
            this.emit("onRunFailed", { run: currentRun ?? run, error });
          }
          break;
        }
        case "step:completed":
          this.emit("onStepCompleted", {
            run,
            step: {
              id: msg.data?.stepId as string,
              runId: run.id,
              name: msg.data?.stepName as string,
              status: "completed",
              output: msg.data?.output as string | undefined,
              completedAt: new Date(),
            },
          });
          break;
        case "onComplete:error":
          this.emit("onCompleteError", {
            run,
            error: (msg.data?.error as string) ?? "Unknown onComplete error",
          });
          break;
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      this.emit("onLogOutput", { run, level: "stdout", message: chunk.toString() });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.emit("onLogOutput", { run, level: "stderr", message: chunk.toString() });
    });

    child.on("error", (err) => {
      resolved = true;
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.decrementPerSignal(run.signalName);
      cleanup();
      console.error(`[station-signal] Failed to spawn process for "${sig.name}":`, err);
    });

    child.on("exit", async () => {
      cleanup();

      // H2: Grace period — let pending IPC message handlers resolve before we act.
      // Node can fire exit synchronously after the last IPC message, before the
      // async message handler has run. Skipped when IPC already resolved the run.
      if (!resolved) {
        await new Promise((r) => setTimeout(r, 200));
      }

      // Always decrement counters first (prevents activeCount drift)
      if (!resolved) {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.decrementPerSignal(run.signalName);
      }

      if (resolved) return;

      // Check if the run was already handled (cancelled/timed out/completed/retried)
      const currentRun = await this.adapter.getRun(run.id);
      if (!currentRun || currentRun.status !== "running") {
        return;
      }

      const error = "Child process exited unexpectedly";
      const attempts = currentRun.attempts;
      const maxAttempts = run.maxAttempts ?? this.defaultMaxAttempts;

      if (attempts < maxAttempts) {
        await this.adapter.updateRun(run.id, { status: "pending", startedAt: undefined, lastRunAt: new Date(), error });
        this.emit("onRunRetry", { run: currentRun, attempt: attempts, maxAttempts });
      } else {
        await this.adapter.updateRun(run.id, { status: "failed", completedAt: new Date(), error });
        this.emit("onRunFailed", { run: currentRun, error });
      }
    });
  }
}
