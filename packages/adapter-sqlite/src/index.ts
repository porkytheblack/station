import Database from "better-sqlite3";
import type { SignalQueueAdapter, QueueEntry } from "simple-signal";

/** Column name mapping: camelCase QueueEntry → snake_case SQLite */
const COLUMN_MAP: Record<string, string> = {
  signalName: "signal_name",
  maxAttempts: "max_attempts",
  nextRunAt: "next_run_at",
  lastRunAt: "last_run_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  createdAt: "created_at",
};

/** Fields that are stored as ISO-8601 text in SQLite */
const DATE_FIELDS = new Set([
  "nextRunAt",
  "lastRunAt",
  "startedAt",
  "completedAt",
  "createdAt",
]);

function toColumn(key: string): string {
  return COLUMN_MAP[key] ?? key;
}

function toField(col: string): string {
  for (const [field, column] of Object.entries(COLUMN_MAP)) {
    if (column === col) return field;
  }
  return col;
}

/** Serialise a Date to ISO string, or pass through null/undefined. */
function dateToStr(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value === undefined || value === null) return null;
  return String(value);
}

/** Deserialise an ISO string back to Date, or return undefined. */
function strToDate(value: unknown): Date | undefined {
  if (typeof value === "string") return new Date(value);
  return undefined;
}

/** Map a raw SQLite row to a QueueEntry. */
function rowToEntry(row: Record<string, unknown>): QueueEntry {
  const entry: Record<string, unknown> = {};
  for (const [col, value] of Object.entries(row)) {
    const field = toField(col);
    if (DATE_FIELDS.has(field)) {
      entry[field] = value != null ? strToDate(value) : undefined;
    } else {
      entry[field] = value;
    }
  }
  return entry as unknown as QueueEntry;
}

export interface SqliteAdapterOptions {
  /** Path to the SQLite database file. Defaults to `"simple-signal.db"`. */
  dbPath?: string;
  /** Table name. Defaults to `"entries"`. */
  tableName?: string;
}

export class SqliteAdapter implements SignalQueueAdapter {
  private db: Database.Database;
  private tableName: string;

  constructor(options: SqliteAdapterOptions = {}) {
    const dbPath = options.dbPath ?? "simple-signal.db";
    this.tableName = options.tableName ?? "entries";
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read/write performance
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id            TEXT PRIMARY KEY,
        signal_name   TEXT NOT NULL,
        kind          TEXT NOT NULL,
        input         TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        max_attempts  INTEGER NOT NULL DEFAULT 1,
        timeout       INTEGER NOT NULL,
        interval      TEXT,
        next_run_at   TEXT,
        last_run_at   TEXT,
        started_at    TEXT,
        completed_at  TEXT,
        created_at    TEXT NOT NULL
      )
    `);

    // Indexes for the two hot queries (getDue / getRunning)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_status_next
        ON ${this.tableName} (status, next_run_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_status_running
        ON ${this.tableName} (status) WHERE status = 'running'
    `);
  }

  async add(entry: QueueEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ${this.tableName}
          (id, signal_name, kind, input, status, attempts, max_attempts,
           timeout, interval, next_run_at, last_run_at, started_at,
           completed_at, created_at)
         VALUES
          (@id, @signal_name, @kind, @input, @status, @attempts, @max_attempts,
           @timeout, @interval, @next_run_at, @last_run_at, @started_at,
           @completed_at, @created_at)`,
      )
      .run({
        id: entry.id,
        signal_name: entry.signalName,
        kind: entry.kind,
        input: entry.input,
        status: entry.status,
        attempts: entry.attempts,
        max_attempts: entry.maxAttempts,
        timeout: entry.timeout,
        interval: entry.interval ?? null,
        next_run_at: dateToStr(entry.nextRunAt),
        last_run_at: dateToStr(entry.lastRunAt),
        started_at: dateToStr(entry.startedAt),
        completed_at: dateToStr(entry.completedAt),
        created_at: dateToStr(entry.createdAt),
      });
  }

  async remove(id: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM ${this.tableName} WHERE id = ?`)
      .run(id);
  }

  async getDue(): Promise<QueueEntry[]> {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.tableName}
         WHERE status = 'pending'
           AND (next_run_at IS NULL OR next_run_at <= ?)`,
      )
      .all(now) as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  async getRunning(): Promise<QueueEntry[]> {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.tableName} WHERE status = 'running'`)
      .all() as Record<string, unknown>[];

    return rows.map(rowToEntry);
  }

  async update(id: string, patch: Partial<QueueEntry>): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        // Explicitly set to undefined → NULL in SQLite
        const col = toColumn(key);
        const param = `p_${col}`;
        setClauses.push(`${col} = @${param}`);
        values[param] = null;
      } else {
        const col = toColumn(key);
        const param = `p_${col}`;
        setClauses.push(`${col} = @${param}`);
        values[param] = DATE_FIELDS.has(key) ? dateToStr(value) : value;
      }
    }

    if (setClauses.length === 0) return;

    this.db
      .prepare(
        `UPDATE ${this.tableName} SET ${setClauses.join(", ")} WHERE id = @id`,
      )
      .run(values);
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  generateId(): string {
    return `entry_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
