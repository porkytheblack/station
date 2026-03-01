import { type ChildProcess, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSerializableAdapter, type SignalQueueAdapter } from "./adapters/index.js";
import { MemoryAdapter } from "./adapters/memory.js";
import { configure } from "./config.js";
import { parseInterval } from "./interval.js";
import type { AnySignal } from "./signal.js";
import type { IPCMessage, SignalSubscriber } from "./subscribers/index.js";
import { ConsoleSubscriber } from "./subscribers/console.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type Run, type Step } from "./types.js";
import { isSignal } from "./util.js";

const BOOTSTRAP = fileURLToPath(new URL("./bootstrap.js", import.meta.url));
const TSX_IMPORT = import.meta.resolve("tsx");

interface RegisteredSignal {
  name: string;
  filePath: string;
  maxConcurrency?: number;
}

interface RecurringSchedule {
  signalName: string;
  filePath: string;
  interval: string;
  nextRunAt: Date;
  timeout: number;
  maxAttempts: number;
  input?: string;
}

export interface SignalRunnerOptions {
  signalsDir?: string;
  adapter?: SignalQueueAdapter;
  pollIntervalMs?: number;
  /** Default max attempts for signals that don't specify their own. */
  maxAttempts?: number;
  /** Subscribers notified of signal lifecycle events. */
  subscribers?: SignalSubscriber[];
  /** Maximum number of concurrent child processes. @default 5 */
  maxConcurrent?: number;
  /** Base delay (ms) for exponential retry backoff. @default 1000 */
  retryBackoffMs?: number;
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
  private activeCount = 0;
  private activePerSignal = new Map<string, number>();
  /** Map runId → child process for cancel/timeout kill. */
  private childByRunId = new Map<string, ChildProcess>();
  private running = false;
  private stopping = false;
  private ticking = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SignalRunnerOptions = {}) {
    const adapter = options.adapter ?? new MemoryAdapter();
    configure({ adapter });
    this.adapter = adapter;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
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
  listRegistered(): Array<{ name: string; filePath: string; maxConcurrency?: number }> {
    return Array.from(this.registry.values());
  }

  /** Check whether a signal is registered by name. */
  hasSignal(name: string): boolean {
    return this.registry.has(name);
  }

  register(name: string, filePath: string, options?: { maxConcurrency?: number }): this {
    this.registry.set(name, { name, filePath: resolve(filePath), maxConcurrency: options?.maxConcurrency });
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

  /** List all runs for a signal. */
  async listRuns(signalName: string): Promise<Run[]> {
    return this.adapter.listRuns(signalName);
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

    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[station-signal] tick() failed:", err);
      }
      await this.sleep(this.pollIntervalMs);
    }

    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }

  /** Stop the runner and optionally wait for active children to exit. */
  async stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

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
      nextRunAt: new Date(Date.now() + ms),
      timeout: sig.timeout,
      maxAttempts: sig.maxAttempts,
      input: sig.recurringInput ? JSON.stringify(sig.recurringInput) : undefined,
    });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
    await this.checkTimeouts();
    await this.tickRecurring();

    const due = await this.adapter.getRunsDue();
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
      this.dispatch(sig, dispatchRun);
    }
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
        const ms = parseInterval(schedule.interval);
        schedule.nextRunAt = new Date(Date.now() + ms);
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

      const ms = parseInterval(schedule.interval);
      schedule.nextRunAt = new Date(Date.now() + ms);

      this.emit("onRunRescheduled", { run, nextRunAt: schedule.nextRunAt });
    }
  }

  private async checkTimeouts(): Promise<void> {
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

  private dispatch(sig: RegisteredSignal, run: Run): void {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      STATION_SIGNAL_FILE: sig.filePath,
      STATION_SIGNAL_INPUT: run.input,
      STATION_SIGNAL_NAME: run.signalName,
      STATION_SIGNAL_RUN_ID: run.id,
      STATION_SIGNAL_TIMEOUT: String(run.timeout ?? DEFAULT_TIMEOUT_MS),
    };

    if (this.adapterName) {
      env.STATION_SIGNAL_ADAPTER = this.adapterName;
      if (this.adapterOptions) {
        env.STATION_SIGNAL_ADAPTER_OPTIONS = JSON.stringify(this.adapterOptions);
      }
      if (this.adapterImport) {
        env.STATION_SIGNAL_ADAPTER_IMPORT = this.adapterImport;
      }
    }

    const child = spawn("node", ["--import", TSX_IMPORT, BOOTSTRAP], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

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
      // async message handler has run.
      await new Promise((r) => setTimeout(r, 200));

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
