import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { SerializableAdapter, AdapterManifest, Run, RunPatch, RunStatus, Step, StepPatch, ListRunsOptions, ListAllRunsOptions } from "station-signal";
import { registerAdapter } from "station-signal";

const MODULE_URL = import.meta.url;

import { validateTableName, dateToStr, createColumnMapper, rowToObject } from "./shared.js";

const { toColumn, toField } = createColumnMapper({
  signalName: "signal_name",
  maxAttempts: "max_attempts",
  nextRunAt: "next_run_at",
  lastRunAt: "last_run_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  createdAt: "created_at",
});
const DATE_FIELDS = new Set(["nextRunAt", "lastRunAt", "startedAt", "completedAt", "createdAt"]);

const { toColumn: toStepColumn, toField: toStepField } = createColumnMapper({
  runId: "run_id",
  startedAt: "started_at",
  completedAt: "completed_at",
});
const STEP_DATE_FIELDS = new Set(["startedAt", "completedAt"]);

function rowToRun(row: Record<string, unknown>): Run {
  return rowToObject<Run>(row, toField, DATE_FIELDS);
}
function rowToStep(row: Record<string, unknown>): Step {
  return rowToObject<Step>(row, toStepField, STEP_DATE_FIELDS);
}

export interface SqliteAdapterOptions {
  /** Path to the SQLite database file. Defaults to `"station.db"`. */
  dbPath?: string;
  /** Table name (alphanumeric and underscores only). Defaults to `"runs"`. */
  tableName?: string;
}

export class SqliteAdapter implements SerializableAdapter {
  private db: Database.Database;
  private tableName: string;
  private options: SqliteAdapterOptions;
  /** Prepared-statement cache — better-sqlite3 recompiles on every prepare(). */
  private stmtCache = new Map<string, Database.Statement>();

  private prep(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  constructor(options: SqliteAdapterOptions = {}) {
    this.options = options;
    const dbPath = options.dbPath ?? "station.db";
    this.tableName = validateTableName(options.tableName ?? "runs");
    this.db = new Database(dbPath);

    // Enable WAL mode and foreign keys
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

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
        created_at    TEXT NOT NULL,
        output        TEXT,
        error         TEXT
      )
    `);

    // Migrate existing databases: add columns if missing
    try { this.db.exec(`ALTER TABLE ${this.tableName} ADD COLUMN output TEXT`); } catch { /* already exists */ }
    try { this.db.exec(`ALTER TABLE ${this.tableName} ADD COLUMN error TEXT`); } catch { /* already exists */ }

    // Indexes for the two hot queries (getRunsDue / getRunsRunning)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_status_next
        ON ${this.tableName} (status, next_run_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_status_running
        ON ${this.tableName} (status) WHERE status = 'running'
    `);

    // M3: Index on signal_name for listRuns queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_signal_name
        ON ${this.tableName} (signal_name)
    `);

    // Steps table with foreign key
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName}_steps (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES ${this.tableName}(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        input         TEXT,
        output        TEXT,
        error         TEXT,
        started_at    TEXT,
        completed_at  TEXT
      )
    `);

    // Migrate existing step tables: add error column if missing
    try { this.db.exec(`ALTER TABLE ${this.tableName}_steps ADD COLUMN error TEXT`); } catch { /* already exists */ }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_steps_run_id
        ON ${this.tableName}_steps (run_id)
    `);
  }

  toManifest(): AdapterManifest {
    return {
      name: "sqlite",
      options: this.options as Record<string, unknown>,
      moduleUrl: MODULE_URL,
    };
  }

  async addRun(run: Run): Promise<void> {
    this
      .prep(
        `INSERT INTO ${this.tableName}
          (id, signal_name, kind, input, status, attempts, max_attempts,
           timeout, interval, next_run_at, last_run_at, started_at,
           completed_at, created_at, output, error)
         VALUES
          (@id, @signal_name, @kind, @input, @status, @attempts, @max_attempts,
           @timeout, @interval, @next_run_at, @last_run_at, @started_at,
           @completed_at, @created_at, @output, @error)`,
      )
      .run({
        id: run.id,
        signal_name: run.signalName,
        kind: run.kind,
        input: run.input,
        status: run.status,
        attempts: run.attempts,
        max_attempts: run.maxAttempts,
        timeout: run.timeout,
        interval: run.interval ?? null,
        next_run_at: dateToStr(run.nextRunAt),
        last_run_at: dateToStr(run.lastRunAt),
        started_at: dateToStr(run.startedAt),
        completed_at: dateToStr(run.completedAt),
        created_at: dateToStr(run.createdAt),
        output: run.output ?? null,
        error: run.error ?? null,
      });
  }

  async removeRun(id: string): Promise<void> {
    // Steps cascade via FOREIGN KEY ON DELETE CASCADE
    this
      .prep(`DELETE FROM ${this.tableName} WHERE id = ?`)
      .run(id);
  }

  async getRunsDue(limit?: number): Promise<Run[]> {
    const now = new Date().toISOString();
    const withLimit = limit !== undefined && limit >= 0;
    const rows = this
      .prep(
        `SELECT * FROM ${this.tableName}
         WHERE status = 'pending'
           AND (next_run_at IS NULL OR next_run_at <= ?)
         ORDER BY created_at ASC${withLimit ? " LIMIT ?" : ""}`,
      )
      .all(...(withLimit ? [now, limit] : [now])) as Record<string, unknown>[];

    return rows.map(rowToRun);
  }

  async getRunsRunning(): Promise<Run[]> {
    const rows = this
      .prep(`SELECT * FROM ${this.tableName} WHERE status = 'running'`)
      .all() as Record<string, unknown>[];

    return rows.map(rowToRun);
  }

  async getRun(id: string): Promise<Run | null> {
    const row = this
      .prep(`SELECT * FROM ${this.tableName} WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToRun(row) : null;
  }

  /** Allowed RunPatch keys (L13: whitelist to prevent injection via unexpected keys). */
  private static readonly RUN_PATCH_KEYS = new Set([
    "input", "output", "error", "status", "attempts", "maxAttempts",
    "timeout", "interval", "nextRunAt", "lastRunAt", "startedAt", "completedAt",
  ]);

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      if (!SqliteAdapter.RUN_PATCH_KEYS.has(key)) continue;
      if (value === undefined) {
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

    this
      .prep(
        `UPDATE ${this.tableName} SET ${setClauses.join(", ")} WHERE id = @id`,
      )
      .run(values);
  }

  async listRuns(signalName: string, options?: ListRunsOptions): Promise<Run[]> {
    // No options → preserve legacy behavior (full history, newest-first).
    if (!options) {
      const rows = this
        .prep(
          `SELECT * FROM ${this.tableName} WHERE signal_name = ? ORDER BY created_at DESC`,
        )
        .all(signalName) as Record<string, unknown>[];
      return rows.map(rowToRun);
    }

    const params: unknown[] = [signalName];
    let sql = `SELECT * FROM ${this.tableName} WHERE signal_name = ?`;

    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      sql += ` AND status IN (${placeholders})`;
      params.push(...options.statuses);
    }

    sql += " ORDER BY created_at DESC";

    const hasLimit = options.limit !== undefined && options.limit >= 0;
    const hasOffset = options.offset !== undefined && options.offset >= 0;
    if (hasLimit || hasOffset) {
      // SQLite requires LIMIT before OFFSET; -1 means "no upper bound".
      sql += " LIMIT ?";
      params.push(hasLimit ? options.limit : -1);
    }
    if (hasOffset) {
      sql += " OFFSET ?";
      params.push(options.offset);
    }

    const rows = this.prep(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  async listAllRuns(options?: ListAllRunsOptions): Promise<Run[]> {
    const params: unknown[] = [];
    let sql = `SELECT * FROM ${this.tableName}`;
    const where: string[] = [];

    if (options?.signalName) {
      where.push("signal_name = ?");
      params.push(options.signalName);
    }
    if (options?.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      where.push(`status IN (${placeholders})`);
      params.push(...options.statuses);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;

    sql += " ORDER BY created_at DESC";

    const hasLimit = options?.limit !== undefined && options.limit >= 0;
    const hasOffset = options?.offset !== undefined && options.offset >= 0;
    if (hasLimit || hasOffset) {
      // SQLite requires LIMIT before OFFSET; -1 means "no upper bound".
      sql += " LIMIT ?";
      params.push(hasLimit ? options!.limit : -1);
    }
    if (hasOffset) {
      sql += " OFFSET ?";
      params.push(options!.offset);
    }

    const rows = this.prep(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  async countRunsByStatus(options?: { signalName?: string }): Promise<Partial<Record<RunStatus, number>>> {
    const params: unknown[] = [];
    let sql = `SELECT status, COUNT(*) as n FROM ${this.tableName}`;
    if (options?.signalName) {
      sql += " WHERE signal_name = ?";
      params.push(options.signalName);
    }
    sql += " GROUP BY status";

    const rows = this.prep(sql).all(...params) as Array<{ status: RunStatus; n: number }>;
    const counts: Partial<Record<RunStatus, number>> = {};
    for (const row of rows) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  async hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this
      .prep(
        `SELECT 1 FROM ${this.tableName} WHERE signal_name = ? AND status IN (${placeholders}) LIMIT 1`,
      )
      .get(signalName, ...statuses);
    return row !== undefined;
  }

  async purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const cutoff = olderThan.toISOString();
    // Steps cascade via FOREIGN KEY ON DELETE CASCADE
    const result = this
      .prep(
        `DELETE FROM ${this.tableName} WHERE status IN (${placeholders}) AND completed_at IS NOT NULL AND completed_at < ?`,
      )
      .run(...statuses, cutoff);
    return result.changes;
  }

  async addStep(step: Step): Promise<void> {
    this
      .prep(
        `INSERT INTO ${this.tableName}_steps
          (id, run_id, name, status, input, output, error, started_at, completed_at)
         VALUES
          (@id, @run_id, @name, @status, @input, @output, @error, @started_at, @completed_at)`,
      )
      .run({
        id: step.id,
        run_id: step.runId,
        name: step.name,
        status: step.status,
        input: step.input ?? null,
        output: step.output ?? null,
        error: step.error ?? null,
        started_at: dateToStr(step.startedAt),
        completed_at: dateToStr(step.completedAt),
      });
  }

  /** Allowed StepPatch keys. */
  private static readonly STEP_PATCH_KEYS = new Set([
    "status", "input", "output", "error", "startedAt", "completedAt",
  ]);

  async updateStep(id: string, patch: StepPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      if (!SqliteAdapter.STEP_PATCH_KEYS.has(key)) continue;
      if (value === undefined) {
        const col = toStepColumn(key);
        const param = `p_${col}`;
        setClauses.push(`${col} = @${param}`);
        values[param] = null;
      } else {
        const col = toStepColumn(key);
        const param = `p_${col}`;
        setClauses.push(`${col} = @${param}`);
        values[param] = STEP_DATE_FIELDS.has(key) ? dateToStr(value) : value;
      }
    }

    if (setClauses.length === 0) return;

    this
      .prep(
        `UPDATE ${this.tableName}_steps SET ${setClauses.join(", ")} WHERE id = @id`,
      )
      .run(values);
  }

  async getSteps(runId: string): Promise<Step[]> {
    const rows = this
      .prep(`SELECT * FROM ${this.tableName}_steps WHERE run_id = ?`)
      .all(runId) as Record<string, unknown>[];

    return rows.map(rowToStep);
  }

  async removeSteps(runId: string): Promise<void> {
    this
      .prep(`DELETE FROM ${this.tableName}_steps WHERE run_id = ?`)
      .run(runId);
  }

  async ping(): Promise<boolean> {
    try {
      this.prep("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  generateId(): string {
    return randomUUID();
  }

  async close(): Promise<void> {
    this.stmtCache.clear();
    this.db.close();
  }
}

// Register in the adapter factory for cross-process reconstruction
registerAdapter("sqlite", (options: Record<string, unknown>) => new SqliteAdapter(options as SqliteAdapterOptions));

export { BroadcastSqliteAdapter, type BroadcastSqliteAdapterOptions } from "./broadcast.js";
