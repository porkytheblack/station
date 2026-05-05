import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEntry } from "./log-buffer.js";

/**
 * Append-only JSONL log store. Each line is a JSON-serialized LogEntry.
 * Existing entries are loaded into memory on construction; appends are
 * serialized through an async write queue so concurrent writers can't
 * interleave bytes.
 *
 * No native dependencies — works with any Node 18+ install without
 * needing to compile native bindings at install time.
 */
export class LogStore {
  private path: string;
  private byRunId = new Map<string, LogEntry[]>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    // Backwards compat: callers used to pass `.db` paths for the sqlite store.
    // Transparently swap to `.jsonl` so existing config files keep working.
    this.path = path.endsWith(".db") ? path.replace(/\.db$/, ".jsonl") : path;
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
