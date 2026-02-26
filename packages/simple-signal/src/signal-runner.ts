import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SignalQueueAdapter } from "./adapters/index.js";
import { configure, getAdapter } from "./config.js";
import { parseInterval } from "./interval.js";
import type { AnySignal } from "./signal.js";
import type { IPCMessage, SignalSubscriber } from "./subscribers/index.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, type QueueEntry } from "./types.js";

const BOOTSTRAP = fileURLToPath(new URL("./bootstrap.js", import.meta.url));

interface RegisteredSignal {
  name: string;
  filePath: string;
}

export interface SignalRunnerOptions {
  signalsDir?: string;
  adapter?: SignalQueueAdapter;
  pollIntervalMs?: number;
  /** Default max attempts for signals that don't specify their own. */
  maxAttempts?: number;
  /**
   * Path to a module that calls configure() to set up the shared adapter.
   * The runner imports it on startup; bootstrap imports it in every spawned
   * process before the signal file — ensuring the same adapter is used
   * everywhere without any per-signal-file setup.
   *
   * @example
   * // src/adapter.config.ts
   * import { configure } from "simple-signal";
   * import { RedisAdapter } from "./my-redis-adapter.js";
   * configure({ adapter: new RedisAdapter(process.env.REDIS_URL!) });
   *
   * // src/runner.ts
   * new SignalRunner({
   *   signalsDir: "./src/signals",
   *   configModule: fileURLToPath(new URL("./adapter.config.ts", import.meta.url)),
   * });
   */
  configModule?: string;
  /** Subscribers notified of signal lifecycle events. */
  subscribers?: SignalSubscriber[];
}

export class SignalRunner {
  private adapter: SignalQueueAdapter;
  private pollIntervalMs: number;
  private signalsDir?: string;
  private configModule?: string;
  private defaultMaxAttempts: number;
  private registry = new Map<string, RegisteredSignal>();
  private scheduledRecurring = new Set<string>();
  private subscribers: SignalSubscriber[];
  private running = false;

  constructor(options: SignalRunnerOptions = {}) {
    // If an adapter is passed directly, promote it to the global so that
    // signal.trigger() calls anywhere in this process use the same store.
    if (options.adapter) {
      configure({ adapter: options.adapter });
    }
    this.adapter = options.adapter ?? getAdapter();
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.signalsDir = options.signalsDir;
    this.configModule = options.configModule;
    this.defaultMaxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.subscribers = options.subscribers ? [...options.subscribers] : [];
  }

  /** Manual registration — advanced use when not using signalsDir. */
  register(name: string, filePath: string): this {
    this.registry.set(name, { name, filePath: resolve(filePath) });
    return this;
  }

  /** Add a subscriber for signal lifecycle events. */
  subscribe(subscriber: SignalSubscriber): this {
    this.subscribers.push(subscriber);
    return this;
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
        console.error(`[simple-signal] Subscriber error in ${String(event)}:`, err);
      }
    }
  }

  async start(): Promise<void> {
    // If a configModule is provided, import it first so configure() runs and
    // sets the global adapter before we discover signals or begin polling.
    if (this.configModule) {
      try {
        await import(this.configModule);
        this.adapter = getAdapter(); // pick up whatever the config module set
      } catch (err) {
        console.error(`[simple-signal] Failed to import configModule "${this.configModule}":`, err);
      }
    }

    if (this.signalsDir) {
      await this.discover(resolve(this.signalsDir));
    }

    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error("[simple-signal] tick() failed:", err);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async discover(dir: string): Promise<void> {
    let files: string[];
    try {
      files = (readdirSync(dir, { recursive: true }) as string[])
        .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
        .map((f) => join(dir, f));
    } catch {
      console.error(`[simple-signal] Cannot read signalsDir: ${dir}`);
      return;
    }

    for (const filePath of files) {
      try {
        const mod = await import(filePath);
        for (const value of Object.values(mod)) {
          if (isSignal(value)) {
            this.registry.set(value.name, { name: value.name, filePath });
            this.emit("onSignalDiscovered", { signalName: value.name, filePath });
            if (value.interval && !this.scheduledRecurring.has(value.name)) {
              await this.scheduleRecurring(value);
            }
          }
        }
      } catch (err) {
        console.warn(`[simple-signal] Skipping ${filePath} — failed to import:`, err);
      }
    }
  }

  private async scheduleRecurring(sig: AnySignal): Promise<void> {
    this.scheduledRecurring.add(sig.name);
    const ms = parseInterval(sig.interval!);
    const id = this.adapter.generateId();
    const entry: QueueEntry = {
      id,
      signalName: sig.name,
      kind: "recurring",
      input: JSON.stringify({}),
      status: "pending",
      attempts: 0,
      maxAttempts: sig.maxAttempts,
      timeout: sig.timeout,
      interval: sig.interval,
      nextRunAt: new Date(Date.now() + ms),
      createdAt: new Date(),
    };
    await this.adapter.add(entry);
  }

  private async tick(): Promise<void> {
    await this.checkTimeouts();

    const due = await this.adapter.getDue();
    for (const entry of due) {
      const sig = this.registry.get(entry.signalName);
      if (!sig) {
        console.warn(`[simple-signal] No signal registered for "${entry.signalName}" (entry ${entry.id}) — skipping`);
        continue;
      }

      // Mark as running before spawning
      await this.adapter.update(entry.id, {
        status: "running",
        startedAt: new Date(),
        attempts: entry.attempts + 1,
      });

      this.emit("onEntryDispatched", { entry });
      this.dispatch(sig, entry);

      // Recurring: schedule next run immediately so the slot isn't lost
      if (entry.kind === "recurring" && entry.interval) {
        const ms = parseInterval(entry.interval);
        const nextRunAt = new Date(Date.now() + ms);
        await this.adapter.update(entry.id, {
          lastRunAt: new Date(),
          nextRunAt,
        });
        this.emit("onEntryRescheduled", { entry, nextRunAt });
      }
    }
  }

  private async checkTimeouts(): Promise<void> {
    const running = await this.adapter.getRunning();

    for (const entry of running) {
      if (!entry.startedAt) continue;
      const elapsed = Date.now() - entry.startedAt.getTime();
      if (elapsed < entry.timeout) continue;

      const maxAttempts = entry.maxAttempts ?? this.defaultMaxAttempts;

      this.emit("onEntryTimeout", { entry });

      if (entry.attempts < maxAttempts) {
        // Retry: reset to pending
        await this.adapter.update(entry.id, {
          status: "pending",
          startedAt: undefined,
        });
        this.emit("onEntryRetry", { entry, attempt: entry.attempts, maxAttempts });
      } else {
        // Exhausted retries
        if (entry.kind === "trigger") {
          await this.adapter.update(entry.id, {
            status: "failed",
            completedAt: new Date(),
          });
          this.emit("onEntryFailed", { entry });
        } else {
          // Recurring: don't permanently fail — schedule the next run
          const ms = parseInterval(entry.interval!);
          const nextRunAt = new Date(Date.now() + ms);
          await this.adapter.update(entry.id, {
            status: "pending",
            startedAt: undefined,
            attempts: 0,
            nextRunAt,
          });
          this.emit("onEntryRescheduled", { entry, nextRunAt });
        }
      }
    }
  }

  private dispatch(sig: RegisteredSignal, entry: QueueEntry): void {
    const child = spawn("node", ["--import", "tsx", BOOTSTRAP], {
      env: {
        ...process.env,
        SIMPLE_SIGNAL_FILE: sig.filePath,
        SIMPLE_SIGNAL_INPUT: entry.input,
        SIMPLE_SIGNAL_NAME: entry.signalName,
        SIMPLE_SIGNAL_ENTRY_ID: entry.id,
        SIMPLE_SIGNAL_TIMEOUT: String(entry.timeout ?? DEFAULT_TIMEOUT_MS),
        ...(this.configModule && {
          SIMPLE_SIGNAL_CONFIG_MODULE: this.configModule,
        }),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });

    // IPC messages from bootstrap (lifecycle events)
    child.on("message", async (msg: IPCMessage) => {
      switch (msg.type) {
        case "entry:started":
          this.emit("onEntryStarted", { entry });
          break;
        case "entry:completed":
          this.emit("onEntryCompleted", { entry });
          if (entry.kind === "recurring") {
            // nextRunAt was already updated in tick() — reset status so getDue() picks it up next interval
            await this.adapter.update(entry.id, { status: "pending" });
          } else {
            await this.adapter.update(entry.id, { status: "completed", completedAt: new Date() });
          }
          break;
        case "entry:failed":
          this.emit("onEntryFailed", {
            entry,
            error: (msg.data?.error as string) ?? undefined,
          });
          if (entry.kind === "trigger") {
            await this.adapter.update(entry.id, { status: "failed", completedAt: new Date() });
          }
          break;
      }
    });

    // Capture child stdout/stderr as log output events
    child.stdout?.on("data", (chunk: Buffer) => {
      this.emit("onLogOutput", { entry, level: "stdout", message: chunk.toString() });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.emit("onLogOutput", { entry, level: "stderr", message: chunk.toString() });
    });

    child.on("error", (err) => {
      console.error(`[simple-signal] Failed to spawn process for "${sig.name}":`, err);
    });
    child.unref();
  }
}

function isSignal(value: unknown): value is AnySignal {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.run === "function" &&
    typeof v.inputSchema === "object" &&
    v.inputSchema !== null &&
    typeof (v.inputSchema as Record<string, unknown>).safeParse === "function"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
