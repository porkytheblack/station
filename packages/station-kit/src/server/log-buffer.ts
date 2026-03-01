export interface LogEntry {
  runId: string;
  signalName: string;
  level: "stdout" | "stderr";
  message: string;
  timestamp: string;
}

export class LogBuffer {
  private logs = new Map<string, LogEntry[]>();
  private maxPerRun: number;
  private maxRuns: number;

  constructor(opts?: { maxPerRun?: number; maxRuns?: number }) {
    this.maxPerRun = opts?.maxPerRun ?? 2000;
    this.maxRuns = opts?.maxRuns ?? 500;
  }

  add(entry: LogEntry): void {
    let entries = this.logs.get(entry.runId);
    if (!entries) {
      entries = [];
      this.logs.set(entry.runId, entries);
      // Prune oldest runs if over capacity
      if (this.logs.size > this.maxRuns) {
        const firstKey = this.logs.keys().next().value;
        if (firstKey) this.logs.delete(firstKey);
      }
    }
    entries.push(entry);
    if (entries.length > this.maxPerRun) {
      entries.shift();
    }
  }

  get(runId: string): LogEntry[] {
    return this.logs.get(runId) ?? [];
  }

  clear(): void {
    this.logs.clear();
  }
}
