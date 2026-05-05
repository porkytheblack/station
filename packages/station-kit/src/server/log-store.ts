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
 * `add` is treated as fire-and-forget at the LogStore boundary so signal
 * runners never block on log writes. Adapters that need durability
 * guarantees (queues, retries, batching) should implement that internally.
 */
export interface LogStorageAdapter {
  add(entry: LogEntry): Promise<void> | void;
  get(runId: string): Promise<LogEntry[]> | LogEntry[];
  close?(): Promise<void> | void;
}

// ─── JSONL file default ─────────────────────────────────────────────

export interface JsonlLogStorageOptions {
  filePath: string;
}

/**
 * Append-only JSONL log storage. Each line is a JSON-serialized LogEntry.
 * Existing entries are loaded into memory on construction; appends are
 * serialized through an async write queue so concurrent writers can't
 * interleave bytes.
 *
 * No native dependencies — works on any Node 18+ install. Suitable for
 * single-process deployments and local development. For multi-process
 * or distributed setups, implement `LogStorageAdapter` against
 * Postgres / MySQL / Redis / S3 / etc.
 */
export class JsonlLogStorage implements LogStorageAdapter {
  private path: string;
  private byRunId = new Map<string, LogEntry[]>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonlLogStorageOptions) {
    // Backwards compat: callers used to pass `.db` paths for the sqlite store.
    // Transparently swap to `.jsonl` so existing config files keep working.
    this.path = options.filePath.endsWith(".db")
      ? options.filePath.replace(/\.db$/, ".jsonl")
      : options.filePath;
    mkdirSync(dirname(this.path), { recursive: true });
    this.replay();
  }

  private replay(): void {
    if (!existsSync(this.path)) return;
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch {
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
      () => appendFile(this.path, line).catch(() => {}),
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
   * a shortcut for `new JsonlLogStorage({ filePath })` — useful for
   * local dev and the default Station data directory.
   */
  constructor(storageOrPath: LogStorageAdapter | string) {
    if (typeof storageOrPath === "string") {
      this.storage = new JsonlLogStorage({ filePath: storageOrPath });
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
