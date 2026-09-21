import { mkdirSync, createReadStream } from "node:fs";
import { appendFile, stat, rename } from "node:fs/promises";
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
  onError?: (err: unknown) => void;
  /** Rotate newly written segments at this size (default64MiB). A legacy oversized segment is retained once as previous. */
  maxFileBytes?: number;
  /** Bounded asynchronous write backlog. Default 4 MiB. Overflow invokes onError. */
  maxPendingBytes?: number;
  /** Latest matching entries returned by get(). Default 10000 / 4 MiB. */
  maxQueryEntries?: number;
  maxQueryBytes?: number;
}

/** Single-process JSONL store. No startup replay/index; reads stream two bounded
 * segments and retain only a bounded result. Pending writes and individual lines
 * are bounded too. Rotation retains one previous segment. Not a distributed log. */
export class FileLogStorage implements LogStorageAdapter {
  private path: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private onError: (err: unknown) => void;
  private pendingBytes = 0;
  private readonly maxFileBytes: number;
  private readonly maxPendingBytes: number;
  private readonly maxQueryEntries: number;
  private readonly maxQueryBytes: number;
  private readonly maxLineBytes: number;

  constructor(options: FileLogStorageOptions) {
    this.path = options.filePath.endsWith(".db") ? options.filePath.replace(/\.db$/, ".jsonl") : options.filePath;
    this.onError = options.onError ?? (() => {});
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxPendingBytes = options.maxPendingBytes ?? 4 * 1024 * 1024;
    this.maxQueryEntries = options.maxQueryEntries ?? 10000;
    this.maxQueryBytes = options.maxQueryBytes ?? 4 * 1024 * 1024;
    if ([this.maxFileBytes, this.maxPendingBytes, this.maxQueryEntries, this.maxQueryBytes].some(n => !Number.isSafeInteger(n) || n < 1 || n > 1024 * 1024 * 1024)) throw new Error("Invalid file log storage bounds.");
    this.maxLineBytes = Math.min(64 * 1024, this.maxFileBytes, this.maxPendingBytes, this.maxQueryBytes);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
  }
  private report(error: unknown): void { try { this.onError(error); } catch { /* Monitoring must not wedge writes. */ } }
  add(entry: LogEntry): void {
    const line = JSON.stringify(entry) + "\n", bytes = Buffer.byteLength(line);
    if (bytes > this.maxLineBytes || this.pendingBytes + bytes > this.maxPendingBytes) {
      this.report(new Error("File log capacity exceeded; entry dropped.")); return;
    }
    this.pendingBytes += bytes;
    this.writeQueue = this.writeQueue.then(async () => {
      let size = 0;
      try { size = (await stat(this.path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (size + bytes > this.maxFileBytes) await rename(this.path, `${this.path}.previous`);
      await appendFile(this.path, line, { mode: 0o600 });
    }).catch(error => this.report(error)).finally(() => { this.pendingBytes -= bytes; });
  }
  async get(runId: string): Promise<LogEntry[]> {
    await this.writeQueue;
    const entries: Array<{ entry: LogEntry; bytes: number }> = []; let total = 0;
    const consume = (line: Buffer) => {
      try {
        const entry = JSON.parse(line.toString("utf8")) as LogEntry;
        if (entry.runId !== runId || typeof entry.message !== "string" || typeof entry.signalName !== "string" || typeof entry.timestamp !== "string" || !["stdout", "stderr"].includes(entry.level)) return;
        entries.push({ entry, bytes: line.length }); total += line.length;
        while (entries.length > this.maxQueryEntries || total > this.maxQueryBytes) total -= entries.shift()!.bytes;
      } catch { /* Skip malformed/partial records. */ }
    };
    for (const path of [`${this.path}.previous`, this.path]) {
      let pending: Buffer = Buffer.alloc(0); let oversized = false;
      try {
        for await (const chunk of createReadStream(path, { highWaterMark: 16 * 1024 })) {
          const bytes = chunk as Buffer; let offset = 0;
          while (offset < bytes.length) {
            const newline = bytes.indexOf(10, offset), end = newline < 0 ? bytes.length : newline;
            if (!oversized) {
              if (pending.length + end - offset > this.maxLineBytes) { pending = Buffer.alloc(0); oversized = true; }
              else pending = Buffer.concat([pending, bytes.subarray(offset, end)]);
            }
            if (newline < 0) break;
            if (!oversized && pending.length) consume(pending);
            pending = Buffer.alloc(0); oversized = false; offset = newline + 1;
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.report(error); }
    }
    return entries.map(value => value.entry);
  }
  async close(): Promise<void> { await this.writeQueue; }
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
