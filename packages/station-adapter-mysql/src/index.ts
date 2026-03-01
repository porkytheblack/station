import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
export type { Pool as MysqlPool } from "mysql2/promise";
import type { SerializableAdapter, AdapterManifest, Run, RunPatch, RunStatus, Step, StepPatch } from "station-signal";
import { registerAdapter } from "station-signal";

import { validateTableName, dateToStr, createColumnMapper, rowToObject } from "./shared.js";

const MODULE_URL = import.meta.url;

// ── Column mappings ────────────────────────────────────────────────────

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

// ── Options ────────────────────────────────────────────────────────────

export interface MysqlAdapterOptions {
  /** MySQL connection string (e.g. "mysql://user:pass@host:3306/db"). */
  connectionString?: string;
  /** Existing mysql2 connection pool. Takes precedence over connectionString. */
  pool?: Pool;
  /** Table name for runs (alphanumeric and underscores only). Defaults to "runs". */
  tableName?: string;
}

// ── Adapter ────────────────────────────────────────────────────────────

export class MysqlAdapter implements SerializableAdapter {
  private pool: Pool;
  private tableName: string;
  private stepsTable: string;
  private ownsPool: boolean;
  private options: MysqlAdapterOptions;

  private constructor(pool: Pool, tableName: string, ownsPool: boolean, options: MysqlAdapterOptions) {
    this.pool = pool;
    this.tableName = tableName;
    this.stepsTable = `${tableName}_steps`;
    this.ownsPool = ownsPool;
    this.options = options;
  }

  /**
   * Create a new MysqlAdapter. Table creation is async, so this is the
   * only way to construct the adapter.
   */
  static async create(options: MysqlAdapterOptions = {}): Promise<MysqlAdapter> {
    const tableName = validateTableName(options.tableName ?? "runs");
    const stepsTable = validateTableName(`${tableName}_steps`);

    let pool: Pool;
    let ownsPool: boolean;

    if (options.pool) {
      pool = options.pool;
      ownsPool = false;
    } else {
      const uri = options.connectionString;
      if (!uri) {
        throw new Error(
          "MysqlAdapter requires either a connectionString or an existing pool.",
        );
      }
      pool = mysql.createPool(uri);
      ownsPool = true;
    }

    // Create runs table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id              VARCHAR(36) PRIMARY KEY,
        signal_name     VARCHAR(255) NOT NULL,
        kind            VARCHAR(50) NOT NULL,
        input           TEXT NOT NULL,
        status          VARCHAR(50) NOT NULL DEFAULT 'pending',
        attempts        INT NOT NULL DEFAULT 0,
        max_attempts    INT NOT NULL DEFAULT 1,
        timeout         INT NOT NULL,
        \`interval\`    VARCHAR(255),
        next_run_at     DATETIME(3),
        last_run_at     DATETIME(3),
        started_at      DATETIME(3),
        completed_at    DATETIME(3),
        created_at      DATETIME(3) NOT NULL,
        output          TEXT,
        error           TEXT
      )
    `);

    // Indexes for the two hot queries (getRunsDue / getRunsRunning)
    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_${tableName}_status_next
        ON ${tableName} (status, next_run_at)
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_${tableName}_signal_name
        ON ${tableName} (signal_name)
    `);

    // Steps table with foreign key cascade
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${stepsTable} (
        id              VARCHAR(36) PRIMARY KEY,
        run_id          VARCHAR(36) NOT NULL,
        name            VARCHAR(255) NOT NULL,
        status          VARCHAR(50) NOT NULL DEFAULT 'pending',
        input           TEXT,
        output          TEXT,
        error           TEXT,
        started_at      DATETIME(3),
        completed_at    DATETIME(3),
        CONSTRAINT fk_${stepsTable}_run_id
          FOREIGN KEY (run_id) REFERENCES ${tableName}(id) ON DELETE CASCADE
      )
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_${stepsTable}_run_id
        ON ${stepsTable} (run_id)
    `);

    return new MysqlAdapter(pool, tableName, ownsPool, options);
  }

  toManifest(): AdapterManifest {
    // Only serialize the connectionString and tableName — the pool itself is not serializable
    const manifestOptions: Record<string, unknown> = {};
    if (this.options.connectionString) {
      manifestOptions.connectionString = this.options.connectionString;
    }
    if (this.options.tableName) {
      manifestOptions.tableName = this.options.tableName;
    }
    return {
      name: "mysql",
      options: manifestOptions,
      moduleUrl: MODULE_URL,
    };
  }

  // ── Run methods ────────────────────────────────────────────────────────

  async addRun(run: Run): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.tableName}
        (id, signal_name, kind, input, status, attempts, max_attempts,
         timeout, \`interval\`, next_run_at, last_run_at, started_at,
         completed_at, created_at, output, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.signalName,
        run.kind,
        run.input,
        run.status,
        run.attempts,
        run.maxAttempts,
        run.timeout,
        run.interval ?? null,
        dateToStr(run.nextRunAt),
        dateToStr(run.lastRunAt),
        dateToStr(run.startedAt),
        dateToStr(run.completedAt),
        dateToStr(run.createdAt),
        run.output ?? null,
        run.error ?? null,
      ],
    );
  }

  async removeRun(id: string): Promise<void> {
    await this.pool.execute(
      `DELETE FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  async getRunsDue(): Promise<Run[]> {
    const now = new Date().toISOString();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName}
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC`,
      [now],
    );
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async getRunsRunning(): Promise<Run[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName} WHERE status = 'running'`,
    );
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async getRun(id: string): Promise<Run | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToRun(rows[0] as Record<string, unknown>);
  }

  /** Allowed RunPatch keys — whitelist to prevent injection via unexpected keys. */
  private static readonly RUN_PATCH_KEYS = new Set([
    "input", "output", "error", "status", "attempts", "maxAttempts",
    "timeout", "interval", "nextRunAt", "lastRunAt", "startedAt", "completedAt",
  ]);

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!MysqlAdapter.RUN_PATCH_KEYS.has(key)) continue;
      const col = toColumn(key);
      // "interval" is a MySQL reserved word, quote it
      const quotedCol = col === "interval" ? "`interval`" : col;
      setClauses.push(`${quotedCol} = ?`);
      if (value === undefined) {
        values.push(null);
      } else if (DATE_FIELDS.has(key)) {
        values.push(dateToStr(value));
      } else {
        values.push(value as string | number);
      }
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.pool.execute(
      `UPDATE ${this.tableName} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  async listRuns(signalName: string): Promise<Run[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName} WHERE signal_name = ? ORDER BY created_at DESC`,
      [signalName],
    );
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => "?").join(", ");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM ${this.tableName} WHERE signal_name = ? AND status IN (${placeholders}) LIMIT 1`,
      [signalName, ...statuses],
    );
    return rows.length > 0;
  }

  async purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const cutoff = olderThan.toISOString();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM ${this.tableName} WHERE status IN (${placeholders}) AND completed_at IS NOT NULL AND completed_at < ?`,
      [...statuses, cutoff],
    );
    return result.affectedRows;
  }

  // ── Step methods ───────────────────────────────────────────────────────

  async addStep(step: Step): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.stepsTable}
        (id, run_id, name, status, input, output, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        step.id,
        step.runId,
        step.name,
        step.status,
        step.input ?? null,
        step.output ?? null,
        step.error ?? null,
        dateToStr(step.startedAt),
        dateToStr(step.completedAt),
      ],
    );
  }

  /** Allowed StepPatch keys. */
  private static readonly STEP_PATCH_KEYS = new Set([
    "status", "input", "output", "error", "startedAt", "completedAt",
  ]);

  async updateStep(id: string, patch: StepPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!MysqlAdapter.STEP_PATCH_KEYS.has(key)) continue;
      const col = toStepColumn(key);
      setClauses.push(`${col} = ?`);
      if (value === undefined) {
        values.push(null);
      } else if (STEP_DATE_FIELDS.has(key)) {
        values.push(dateToStr(value));
      } else {
        values.push(value as string | number);
      }
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.pool.execute(
      `UPDATE ${this.stepsTable} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  async getSteps(runId: string): Promise<Step[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.stepsTable} WHERE run_id = ?`,
      [runId],
    );
    return rows.map((row) => rowToStep(row as Record<string, unknown>));
  }

  async removeSteps(runId: string): Promise<void> {
    await this.pool.execute(
      `DELETE FROM ${this.stepsTable} WHERE run_id = ?`,
      [runId],
    );
  }

  // ── Utility ────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.pool.execute("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  generateId(): string {
    return randomUUID();
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}

// Register in the adapter factory for cross-process reconstruction.
// The factory must return a Promise since MysqlAdapter.create is async,
// but the registry expects a synchronous factory. We register a wrapper
// that creates the adapter eagerly — callers using registerAdapter with
// mysql should await the result.
registerAdapter("mysql", (options: Record<string, unknown>) => {
  // The registry expects a synchronous SignalQueueAdapter. Since MySQL
  // initialization is async, we return a proxy that defers all calls
  // until the pool is ready. However, the simpler station pattern is
  // for users to call MysqlAdapter.create() directly. This registration
  // exists for cross-process reconstruction via toManifest/createAdapter,
  // where the caller can handle the async factory.

  // For cross-process compat, we create synchronously and let the first
  // operation establish the connection. mysql2.createPool is synchronous;
  // only the CREATE TABLE calls are async. We handle this by eagerly
  // creating the adapter and running table creation on the first call.
  const connectionString = options.connectionString as string | undefined;
  const tableName = options.tableName as string | undefined;

  if (!connectionString) {
    throw new Error(
      "MysqlAdapter requires a connectionString in options for cross-process reconstruction.",
    );
  }

  const validatedTableName = validateTableName(tableName ?? "runs");
  const stepsTableName = `${validatedTableName}_steps`;
  const pool = mysql.createPool(connectionString);

  // Run table creation asynchronously. The pool will queue operations,
  // so queries issued before this finishes will wait for the connection.
  const initPromise = initializeTables(pool, validatedTableName, stepsTableName);

  // Return a lazy adapter that awaits init on every call
  return new LazyMysqlAdapter(pool, validatedTableName, stepsTableName, initPromise, options);
});

/** Run CREATE TABLE IF NOT EXISTS statements. */
async function initializeTables(pool: Pool, tableName: string, stepsTable: string): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id              VARCHAR(36) PRIMARY KEY,
      signal_name     VARCHAR(255) NOT NULL,
      kind            VARCHAR(50) NOT NULL,
      input           TEXT NOT NULL,
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      attempts        INT NOT NULL DEFAULT 0,
      max_attempts    INT NOT NULL DEFAULT 1,
      timeout         INT NOT NULL,
      \`interval\`    VARCHAR(255),
      next_run_at     DATETIME(3),
      last_run_at     DATETIME(3),
      started_at      DATETIME(3),
      completed_at    DATETIME(3),
      created_at      DATETIME(3) NOT NULL,
      output          TEXT,
      error           TEXT
    )
  `);

  await pool.execute(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_status_next
      ON ${tableName} (status, next_run_at)
  `);

  await pool.execute(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_signal_name
      ON ${tableName} (signal_name)
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS ${stepsTable} (
      id              VARCHAR(36) PRIMARY KEY,
      run_id          VARCHAR(36) NOT NULL,
      name            VARCHAR(255) NOT NULL,
      status          VARCHAR(50) NOT NULL DEFAULT 'pending',
      input           TEXT,
      output          TEXT,
      error           TEXT,
      started_at      DATETIME(3),
      completed_at    DATETIME(3),
      CONSTRAINT fk_${stepsTable}_run_id
        FOREIGN KEY (run_id) REFERENCES ${tableName}(id) ON DELETE CASCADE
    )
  `);

  await pool.execute(`
    CREATE INDEX IF NOT EXISTS idx_${stepsTable}_run_id
      ON ${stepsTable} (run_id)
  `);
}

/**
 * Lazy adapter returned by the synchronous adapter factory.
 * Defers all operations until table initialization completes.
 */
class LazyMysqlAdapter implements SerializableAdapter {
  private pool: Pool;
  private tableName: string;
  private stepsTable: string;
  private initPromise: Promise<void>;
  private opts: Record<string, unknown>;

  constructor(pool: Pool, tableName: string, stepsTable: string, initPromise: Promise<void>, opts: Record<string, unknown>) {
    this.pool = pool;
    this.tableName = tableName;
    this.stepsTable = stepsTable;
    this.initPromise = initPromise;
    this.opts = opts;
  }

  private async ready(): Promise<void> {
    await this.initPromise;
  }

  toManifest(): AdapterManifest {
    const manifestOptions: Record<string, unknown> = {};
    if (this.opts.connectionString) {
      manifestOptions.connectionString = this.opts.connectionString;
    }
    if (this.opts.tableName) {
      manifestOptions.tableName = this.opts.tableName;
    }
    return {
      name: "mysql",
      options: manifestOptions,
      moduleUrl: MODULE_URL,
    };
  }

  async addRun(run: Run): Promise<void> {
    await this.ready();
    await this.pool.execute(
      `INSERT INTO ${this.tableName}
        (id, signal_name, kind, input, status, attempts, max_attempts,
         timeout, \`interval\`, next_run_at, last_run_at, started_at,
         completed_at, created_at, output, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id, run.signalName, run.kind, run.input, run.status, run.attempts,
        run.maxAttempts, run.timeout, run.interval ?? null,
        dateToStr(run.nextRunAt), dateToStr(run.lastRunAt),
        dateToStr(run.startedAt), dateToStr(run.completedAt),
        dateToStr(run.createdAt), run.output ?? null, run.error ?? null,
      ],
    );
  }

  async removeRun(id: string): Promise<void> {
    await this.ready();
    await this.pool.execute(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
  }

  async getRunsDue(): Promise<Run[]> {
    await this.ready();
    const now = new Date().toISOString();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName}
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC`,
      [now],
    );
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async getRunsRunning(): Promise<Run[]> {
    await this.ready();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName} WHERE status = 'running'`,
    );
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async getRun(id: string): Promise<Run | null> {
    await this.ready();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToRun(rows[0] as Record<string, unknown>);
  }

  private static readonly RUN_PATCH_KEYS = new Set([
    "input", "output", "error", "status", "attempts", "maxAttempts",
    "timeout", "interval", "nextRunAt", "lastRunAt", "startedAt", "completedAt",
  ]);

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!LazyMysqlAdapter.RUN_PATCH_KEYS.has(key)) continue;
      const col = toColumn(key);
      const quotedCol = col === "interval" ? "`interval`" : col;
      setClauses.push(`${quotedCol} = ?`);
      if (value === undefined) {
        values.push(null);
      } else if (DATE_FIELDS.has(key)) {
        values.push(dateToStr(value));
      } else {
        values.push(value as string | number);
      }
    }

    if (setClauses.length === 0) return;
    values.push(id);
    await this.pool.execute(
      `UPDATE ${this.tableName} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  async listRuns(signalName: string): Promise<Run[]> {
    await this.ready();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.tableName} WHERE signal_name = ? ORDER BY created_at DESC`,
      [signalName],
    );
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async hasRunWithStatus(signalName: string, statuses: RunStatus[]): Promise<boolean> {
    await this.ready();
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => "?").join(", ");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM ${this.tableName} WHERE signal_name = ? AND status IN (${placeholders}) LIMIT 1`,
      [signalName, ...statuses],
    );
    return rows.length > 0;
  }

  async purgeRuns(olderThan: Date, statuses: RunStatus[]): Promise<number> {
    await this.ready();
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const cutoff = olderThan.toISOString();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM ${this.tableName} WHERE status IN (${placeholders}) AND completed_at IS NOT NULL AND completed_at < ?`,
      [...statuses, cutoff],
    );
    return result.affectedRows;
  }

  async addStep(step: Step): Promise<void> {
    await this.ready();
    await this.pool.execute(
      `INSERT INTO ${this.stepsTable}
        (id, run_id, name, status, input, output, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        step.id, step.runId, step.name, step.status,
        step.input ?? null, step.output ?? null, step.error ?? null,
        dateToStr(step.startedAt), dateToStr(step.completedAt),
      ],
    );
  }

  private static readonly STEP_PATCH_KEYS = new Set([
    "status", "input", "output", "error", "startedAt", "completedAt",
  ]);

  async updateStep(id: string, patch: StepPatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!LazyMysqlAdapter.STEP_PATCH_KEYS.has(key)) continue;
      const col = toStepColumn(key);
      setClauses.push(`${col} = ?`);
      if (value === undefined) {
        values.push(null);
      } else if (STEP_DATE_FIELDS.has(key)) {
        values.push(dateToStr(value));
      } else {
        values.push(value as string | number);
      }
    }

    if (setClauses.length === 0) return;
    values.push(id);
    await this.pool.execute(
      `UPDATE ${this.stepsTable} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  async getSteps(runId: string): Promise<Step[]> {
    await this.ready();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.stepsTable} WHERE run_id = ?`,
      [runId],
    );
    return rows.map((row) => rowToStep(row as Record<string, unknown>));
  }

  async removeSteps(runId: string): Promise<void> {
    await this.ready();
    await this.pool.execute(
      `DELETE FROM ${this.stepsTable} WHERE run_id = ?`,
      [runId],
    );
  }

  async ping(): Promise<boolean> {
    try {
      await this.ready();
      await this.pool.execute("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  generateId(): string {
    return randomUUID();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { BroadcastMysqlAdapter, type BroadcastMysqlAdapterOptions } from "./broadcast.js";
