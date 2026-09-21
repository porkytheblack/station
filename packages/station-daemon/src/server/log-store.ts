import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry } from "./log-buffer.js";

/**
 * Pluggable storage backend for run logs. Implementations only persist
 * and query records — bounded in-memory buffering for live UI streams
 * lives in `LogBuffer`. May be sync or async; the LogStore wrapper
 * normalizes both.
 *
 * Contract for implementers:
 *
 * - **`add(entry)`** is treated as fire-and-forget at the LogStore
 *   boundary. Signal runners never block on log writes. Adapters that
 *   need durability guarantees (queues, retries, batching) should
 *   implement that internally; thrown errors and rejected promises are
 *   caught and surfaced via the LogStore's `onError` hook (if set) but
 *   never rethrown to the caller.
 * - **`get(runId)`** must return entries for that run in append order
 *   (oldest first). Routes that aggregate across runs may re-sort by
 *   timestamp, but per-run ordering is the adapter's responsibility.
 * - **`close?()`** is called once on graceful shutdown. Use it to flush
 *   any in-flight buffers. It is NOT called on `SIGKILL` / OOM kill —
 *   adapters that must guarantee durability per write should not rely
 *   on it.
 *
 * Single-process semantics: the built-in `FileLogStorage` is safe for a
 * single Node process. Running multiple processes against the same file
 * path WILL produce interleaved bytes and lost entries — use a real
 * database adapter (Postgres, MySQL, Redis, etc.) for multi-process or
 * distributed deployments.
 */
export interface LogStorageAdapter {
  add(entry: LogEntry): Promise<void> | void;
  get(runId: string): Promise<LogEntry[]> | LogEntry[];
  close?(): Promise<void> | void;
}

// ─── File-backed default ────────────────────────────────────────────

export interface FileLogStorageOptions {
  filePath: string;
  /**
   * Called when a background write to the underlying file fails. Use
   * this to surface persistence problems (disk full, permission denied,
   * etc.) to your monitoring system. If unset, write failures are
   * silently dropped — acceptable for local dev, NOT for production.
   */
  onError?: (err: unknown) => void;
}

/**
 * File-backed log storage using append-only JSONL framing. Each line is
 * a JSON-serialized `LogEntry`; existing entries are loaded into memory
 * on construction; appends are serialized through an async write queue
 * so concurrent writers can't interleave bytes within one process.
 *
 * No native dependencies — works on any Node 18+ install.
 *
 * **Production caveats** (in order of severity):
 *
 * 1. **Single-process only.** Two Node processes appending to the same
 *    file WILL interleave bytes once individual JSON lines exceed the
 *    OS pipe buffer (4 KB on Linux), corrupting the file.
 * 2. **Best-effort durability.** Writes are queued and flushed via
 *    `fs.appendFile`; on `SIGKILL` / OOM kill, in-flight writes are lost.
 *    Set `onError` to surface fs failures.
 * 3. **Unbounded memory on replay.** The whole file is loaded into a
 *    Map on startup. For high-volume deployments (gigabytes of logs)
 *    use a database-backed adapter instead.
 *
 * For multi-process, distributed, or high-durability deployments,
 * implement `LogStorageAdapter` against Postgres / MySQL / Redis / S3.
 */
export class FileLogStorage implements LogStorageAdapter {
  private path: string;
  private byRunId = new Map<string, LogEntry[]>();
  private writeQueue: Promise<void> = Promise.resolve();
  private onError: (err: unknown) => void;

  constructor(options: FileLogStorageOptions) {
    // Backwards compat: callers used to pass `.db` paths for the sqlite store.
    // Transparently swap to `.jsonl` so existing config files keep working.
    this.path = options.filePath.endsWith(".db")
      ? options.filePath.replace(/\.db$/, ".jsonl")
      : options.filePath;
    this.onError = options.onError ?? (() => {});
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.replay();
  }

  private replay(): void {
    if (!existsSync(this.path)) return;
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (err) {
      this.onError(err);
      return;
    }
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as LogEntry;
        this.indexEntry(entry);
      } catch {
        // Skip malformed line; a partial write may have left a truncated tail.
      }
    }
  }

  private indexEntry(entry: LogEntry): void {
    let entries = this.byRunId.get(entry.runId);
    if (!entries) {
      entries = [];
      this.byRunId.set(entry.runId, entries);
    }
    entries.push(entry);
  }

  add(entry: LogEntry): void {
    this.indexEntry(entry);
    const line = JSON.stringify(entry) + "\n";
    this.writeQueue = this.writeQueue.then(
      () => appendFile(this.path, line, { mode: 0o600 }).catch((err) => {
        this.onError(err);
      }),
    );
  }

  get(runId: string): LogEntry[] {
    return this.byRunId.get(runId) ?? [];
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }
}

// ─── In-memory storage for tests / ephemeral deployments ────────────

export class MemoryLogStorage implements LogStorageAdapter {
  private byRunId = new Map<string, LogEntry[]>();

  add(entry: LogEntry): void {
    let entries = this.byRunId.get(entry.runId);
    if (!entries) {
      entries = [];
      this.byRunId.set(entry.runId, entries);
    }
    entries.push(entry);
  }

  get(runId: string): LogEntry[] {
    return this.byRunId.get(runId) ?? [];
  }
}

// ─── LogStore — thin wrapper that delegates to an adapter ───────────

/**
 * LogStore is the consumer-facing handle that wraps a `LogStorageAdapter`.
 * It exists so signal runners and route handlers can interact with a
 * single concrete type, while the underlying persistence is swappable.
 *
 * `add` is fire-and-forget — adapter promises are caught at this boundary
 * so a slow or failing log backend can never block (or crash) a signal
 * runner. `get` always returns a Promise so callers can transparently
 * support async backends (Postgres, Redis, etc.).
 */
export class LogStore {
  private storage: LogStorageAdapter;

  /**
   * Pass a `LogStorageAdapter` for any backend. The string overload is
   * a shortcut for `new FileLogStorage({ filePath })` — useful for
   * local dev and the default Station data directory.
   */
  constructor(storageOrPath: LogStorageAdapter | string) {
    if (typeof storageOrPath === "string") {
      this.storage = new FileLogStorage({ filePath: storageOrPath });
    } else {
      this.storage = storageOrPath;
    }
  }

  add(entry: LogEntry): void {
    try {
      const result = this.storage.add(entry);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Swallow sync throws; a broken log adapter must not crash signal runs.
    }
  }

  async get(runId: string): Promise<LogEntry[]> {
    return await this.storage.get(runId);
  }

  async close(): Promise<void> {
    if (this.storage.close) await this.storage.close();
  }
}
