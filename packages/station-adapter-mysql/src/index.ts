import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
export type { Pool as MysqlPool } from "mysql2/promise";
import type { SerializableAdapter, AdapterManifest, Run, RunClaim, RunPatch, RunStatus, Step, StepPatch, ListRunsOptions, ListAllRunsOptions } from "station-signal";
import { registerAdapter } from "station-signal";

import { validateTableName, dateToStr, createColumnMapper, rowToObject, runIdempotentDdl } from "./shared.js";

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
  stationId: "station_id",
  leaseToken: "lease_token",
  leaseExpiresAt: "lease_expires_at",
  claimedAt: "claimed_at",
  scheduleId: "schedule_id",
  scheduledFor: "scheduled_for",
  idempotencyKey: "idempotency_key",
});
const DATE_FIELDS = new Set(["nextRunAt", "lastRunAt", "startedAt", "completedAt", "createdAt", "leaseExpiresAt", "claimedAt", "scheduledFor"]);

const RUN_PATCH_KEYS = new Set([
  "input", "output", "error", "status", "attempts", "maxAttempts",
  "timeout", "interval", "nextRunAt", "lastRunAt", "startedAt", "completedAt",
  "stationId", "leaseToken", "leaseExpiresAt", "claimedAt", "scheduleId",
  "scheduledFor", "idempotencyKey",
]);

const { toColumn: toStepColumn, toField: toStepField } = createColumnMapper({
  runId: "run_id",
  startedAt: "started_at",
  completedAt: "completed_at",
});
const STEP_DATE_FIELDS = new Set(["startedAt", "completedAt"]);

function rowToRun(row: Record<string, unknown>): Run {
  return rowToObject<Run>(row, toField, DATE_FIELDS);
}

/**
 * Append LIMIT/OFFSET clauses for a paginated listing, pushing bound params.
 * MySQL requires LIMIT before OFFSET and rejects a bare OFFSET, so when an
 * offset is given without a limit we use the max BIGINT UNSIGNED sentinel.
 */
function buildLimitOffset(
  options: { limit?: number; offset?: number },
  params: (string | number)[],
): string {
  const hasLimit = options.limit !== undefined && options.limit >= 0;
  const hasOffset = options.offset !== undefined && options.offset >= 0;
  let sql = "";
  if (hasLimit) {
    sql += ` LIMIT ?`;
    params.push(options.limit as number);
    if (hasOffset) {
      sql += ` OFFSET ?`;
      params.push(options.offset as number);
    }
  } else if (hasOffset) {
    sql += ` LIMIT 18446744073709551615 OFFSET ?`;
    params.push(options.offset as number);
  }
  return sql;
}
function rowToStep(row: Record<string, unknown>): Step {
  return rowToObject<Step>(row, toStepField, STEP_DATE_FIELDS);
}

async function ensureRunLeaseColumns(pool: Pool, tableName: string): Promise<void> {
  const columns = [
    "station_id VARCHAR(255)",
    "lease_token VARCHAR(64)",
    "lease_expires_at DATETIME(3)",
    "claimed_at DATETIME(3)",
    "schedule_id VARCHAR(255)",
    "scheduled_for DATETIME(3)",
    "idempotency_key VARCHAR(255)",
  ];
  for (const column of columns) {
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `ALTER TABLE ${tableName} ADD COLUMN ${column}`,
    );
  }
}

async function claimMysqlRun(
  pool: Pool,
  tableName: string,
  id: string,
  claim: RunClaim,
): Promise<Run | null> {
  const claimedAt = dateToStr(claim.claimedAt);
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE ${tableName}
     SET status = 'running', station_id = ?, lease_token = ?, lease_expires_at = ?,
         claimed_at = ?, started_at = ?, last_run_at = ?, attempts = attempts + 1
     WHERE id = ? AND status = 'pending'
       AND (next_run_at IS NULL OR next_run_at <= ?)`,
    [claim.stationId, claim.leaseToken, dateToStr(claim.leaseExpiresAt), claimedAt,
      claimedAt, claimedAt, id, claimedAt],
  );
  if (result.affectedRows !== 1) return null;
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT * FROM ${tableName} WHERE id = ?`, [id]);
  return rows.length > 0 ? rowToRun(rows[0] as Record<string, unknown>) : null;
}

async function renewMysqlRunLease(
  pool: Pool,
  tableName: string,
  id: string,
  leaseToken: string,
  leaseExpiresAt: Date,
  now: Date,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE ${tableName} SET lease_expires_at = ?
     WHERE id = ? AND status = 'running' AND lease_token = ? AND lease_expires_at > ?`,
    [dateToStr(leaseExpiresAt), id, leaseToken, dateToStr(now)],
  );
  return result.affectedRows === 1;
}

async function cancelMysqlRun(
  pool: Pool,
  tableName: string,
  id: string,
  completedAt: Date,
): Promise<boolean> {
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE ${tableName}
     SET status='cancelled', completed_at=?, lease_token=NULL, lease_expires_at=NULL, claimed_at=NULL
     WHERE id=? AND status IN ('pending','running')`,
    [dateToStr(completedAt), id],
  );
  return result.affectedRows === 1;
}

async function updateClaimedMysqlRun(
  pool: Pool,
  tableName: string,
  id: string,
  leaseToken: string,
  patch: RunPatch,
): Promise<boolean> {
  const setClauses: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!RUN_PATCH_KEYS.has(key)) continue;
    const col = toColumn(key);
    setClauses.push(`${col === "interval" ? "`interval`" : col} = ?`);
    values.push(value === undefined ? null : DATE_FIELDS.has(key) ? dateToStr(value) : value as string | number);
  }
  if (setClauses.length === 0) return false;
  values.push(id, leaseToken);
  const [result] = await pool.execute<ResultSetHeader>(
    `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE id = ? AND status = 'running' AND lease_token = ?`,
    values,
  );
  return result.affectedRows === 1;
}

async function requeueExpiredMysqlRuns(pool: Pool, tableName: string, now: Date): Promise<number> {
  const stamp = dateToStr(now);
  const [failed] = await pool.execute<ResultSetHeader>(
    `UPDATE ${tableName}
     SET status = 'failed', completed_at = ?,
         error = 'Station lease expired and all attempts were exhausted',
         lease_token = NULL, lease_expires_at = NULL
     WHERE status = 'running' AND lease_expires_at <= ? AND attempts >= max_attempts`,
    [stamp, stamp],
  );
  const [pending] = await pool.execute<ResultSetHeader>(
    `UPDATE ${tableName}
     SET status = 'pending', started_at = NULL, last_run_at = ?,
         error = 'Station lease expired; run recovered for retry',
         station_id = NULL, lease_token = NULL, lease_expires_at = NULL, claimed_at = NULL
     WHERE status = 'running' AND lease_expires_at <= ? AND attempts < max_attempts`,
    [stamp, stamp],
  );
  return failed.affectedRows + pending.affectedRows;
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
        error           TEXT,
        station_id      VARCHAR(255),
        lease_token     VARCHAR(64),
        lease_expires_at DATETIME(3),
        claimed_at      DATETIME(3),
        schedule_id     VARCHAR(255),
        scheduled_for   DATETIME(3),
        idempotency_key VARCHAR(255)
      )
    `);
    await ensureRunLeaseColumns(pool, tableName);

    // Indexes for the two hot queries (getRunsDue / getRunsRunning).
    // Stock MySQL doesn't support CREATE INDEX IF NOT EXISTS; the helper
    // turns the duplicate-name error into a no-op.
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${tableName}_status_next ON ${tableName} (status, next_run_at)`,
    );

    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${tableName}_signal_name ON ${tableName} (signal_name)`,
    );
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE UNIQUE INDEX idx_${tableName}_idempotency_key ON ${tableName} (idempotency_key)`,
    );

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

    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${stepsTable}_run_id ON ${stepsTable} (run_id)`,
    );

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
         completed_at, created_at, output, error, station_id, lease_token,
         lease_expires_at, claimed_at, schedule_id, scheduled_for, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        run.stationId ?? null,
        run.leaseToken ?? null,
        dateToStr(run.leaseExpiresAt),
        dateToStr(run.claimedAt),
        run.scheduleId ?? null,
        dateToStr(run.scheduledFor),
        run.idempotencyKey ?? null,
      ],
    );
  }

  async removeRun(id: string): Promise<void> {
    await this.pool.execute(
      `DELETE FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  async getRunsDue(limit?: number): Promise<Run[]> {
    const now = dateToStr(new Date());
    const params: (string | number | null)[] = [now];
    let sql = `SELECT * FROM ${this.tableName}
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC`;
    if (limit !== undefined && limit >= 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
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
  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!RUN_PATCH_KEYS.has(key)) continue;
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

  async claimRun(id: string, claim: RunClaim): Promise<Run | null> {
    return claimMysqlRun(this.pool, this.tableName, id, claim);
  }

  async cancelRun(id: string, completedAt: Date): Promise<boolean> {
    return cancelMysqlRun(this.pool, this.tableName, id, completedAt);
  }

  async renewRunLease(id: string, leaseToken: string, leaseExpiresAt: Date, now = new Date()): Promise<boolean> {
    return renewMysqlRunLease(this.pool, this.tableName, id, leaseToken, leaseExpiresAt, now);
  }

  async updateClaimedRun(id: string, leaseToken: string, patch: RunPatch): Promise<boolean> {
    return updateClaimedMysqlRun(this.pool, this.tableName, id, leaseToken, patch);
  }

  async requeueExpiredRuns(now: Date): Promise<number> {
    return requeueExpiredMysqlRuns(this.pool, this.tableName, now);
  }

  async listRuns(signalName: string, options?: ListRunsOptions): Promise<Run[]> {
    // No options → preserve legacy behavior (full history, created_at DESC).
    if (!options) {
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT * FROM ${this.tableName} WHERE signal_name = ? ORDER BY created_at DESC`,
        [signalName],
      );
      return rows.map((row) => rowToRun(row as Record<string, unknown>));
    }
    const params: (string | number)[] = [signalName];
    let sql = `SELECT * FROM ${this.tableName} WHERE signal_name = ?`;
    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      sql += ` AND status IN (${placeholders})`;
      params.push(...options.statuses);
    }
    sql += ` ORDER BY created_at DESC`;
    sql += buildLimitOffset(options, params);
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async listAllRuns(options?: ListAllRunsOptions): Promise<Run[]> {
    const params: (string | number)[] = [];
    const where: string[] = [];
    if (options?.signalName) {
      where.push(`signal_name = ?`);
      params.push(options.signalName);
    }
    if (options?.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      where.push(`status IN (${placeholders})`);
      params.push(...options.statuses);
    }
    let sql = `SELECT * FROM ${this.tableName}`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC`;
    sql += buildLimitOffset(options ?? {}, params);
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async countRunsByStatus(options?: { signalName?: string }): Promise<Partial<Record<RunStatus, number>>> {
    const params: string[] = [];
    let sql = `SELECT status, COUNT(*) AS n FROM ${this.tableName}`;
    if (options?.signalName) {
      sql += ` WHERE signal_name = ?`;
      params.push(options.signalName);
    }
    sql += ` GROUP BY status`;
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
    const counts: Partial<Record<RunStatus, number>> = {};
    for (const row of rows) {
      const { status, n } = row as { status: RunStatus; n: number | string };
      counts[status] = Number(n);
    }
    return counts;
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
    const cutoff = dateToStr(olderThan);
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
      error           TEXT,
      station_id      VARCHAR(255),
      lease_token     VARCHAR(64),
      lease_expires_at DATETIME(3),
      claimed_at      DATETIME(3),
      schedule_id     VARCHAR(255),
      scheduled_for   DATETIME(3),
      idempotency_key VARCHAR(255)
    )
  `);
  await ensureRunLeaseColumns(pool, tableName);

  // Stock MySQL doesn't support CREATE INDEX IF NOT EXISTS; the helper
  // turns the duplicate-name error into a no-op.
  await runIdempotentDdl(
    (sql) => pool.execute(sql),
    `CREATE INDEX idx_${tableName}_status_next ON ${tableName} (status, next_run_at)`,
  );

  await runIdempotentDdl(
    (sql) => pool.execute(sql),
    `CREATE INDEX idx_${tableName}_signal_name ON ${tableName} (signal_name)`,
  );
  await runIdempotentDdl(
    (sql) => pool.execute(sql),
    `CREATE UNIQUE INDEX idx_${tableName}_idempotency_key ON ${tableName} (idempotency_key)`,
  );

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

  await runIdempotentDdl(
    (sql) => pool.execute(sql),
    `CREATE INDEX idx_${stepsTable}_run_id ON ${stepsTable} (run_id)`,
  );
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
         completed_at, created_at, output, error, station_id, lease_token,
         lease_expires_at, claimed_at, schedule_id, scheduled_for, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id, run.signalName, run.kind, run.input, run.status, run.attempts,
        run.maxAttempts, run.timeout, run.interval ?? null,
        dateToStr(run.nextRunAt), dateToStr(run.lastRunAt),
        dateToStr(run.startedAt), dateToStr(run.completedAt),
        dateToStr(run.createdAt), run.output ?? null, run.error ?? null,
        run.stationId ?? null, run.leaseToken ?? null,
        dateToStr(run.leaseExpiresAt), dateToStr(run.claimedAt),
        run.scheduleId ?? null, dateToStr(run.scheduledFor), run.idempotencyKey ?? null,
      ],
    );
  }

  async removeRun(id: string): Promise<void> {
    await this.ready();
    await this.pool.execute(`DELETE FROM ${this.tableName} WHERE id = ?`, [id]);
  }

  async getRunsDue(limit?: number): Promise<Run[]> {
    await this.ready();
    const now = dateToStr(new Date());
    const params: (string | number | null)[] = [now];
    let sql = `SELECT * FROM ${this.tableName}
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC`;
    if (limit !== undefined && limit >= 0) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
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

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!RUN_PATCH_KEYS.has(key)) continue;
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

  async claimRun(id: string, claim: RunClaim): Promise<Run | null> {
    await this.ready();
    return claimMysqlRun(this.pool, this.tableName, id, claim);
  }

  async cancelRun(id: string, completedAt: Date): Promise<boolean> {
    await this.ready();
    return cancelMysqlRun(this.pool, this.tableName, id, completedAt);
  }

  async renewRunLease(id: string, leaseToken: string, leaseExpiresAt: Date, now = new Date()): Promise<boolean> {
    await this.ready();
    return renewMysqlRunLease(this.pool, this.tableName, id, leaseToken, leaseExpiresAt, now);
  }

  async updateClaimedRun(id: string, leaseToken: string, patch: RunPatch): Promise<boolean> {
    await this.ready();
    return updateClaimedMysqlRun(this.pool, this.tableName, id, leaseToken, patch);
  }

  async requeueExpiredRuns(now: Date): Promise<number> {
    await this.ready();
    return requeueExpiredMysqlRuns(this.pool, this.tableName, now);
  }

  async listRuns(signalName: string, options?: ListRunsOptions): Promise<Run[]> {
    await this.ready();
    // No options → preserve legacy behavior (full history, created_at DESC).
    if (!options) {
      const [rows] = await this.pool.execute<RowDataPacket[]>(
        `SELECT * FROM ${this.tableName} WHERE signal_name = ? ORDER BY created_at DESC`,
        [signalName],
      );
      return rows.map((row) => rowToRun(row as Record<string, unknown>));
    }
    const params: (string | number)[] = [signalName];
    let sql = `SELECT * FROM ${this.tableName} WHERE signal_name = ?`;
    if (options.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      sql += ` AND status IN (${placeholders})`;
      params.push(...options.statuses);
    }
    sql += ` ORDER BY created_at DESC`;
    sql += buildLimitOffset(options, params);
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async listAllRuns(options?: ListAllRunsOptions): Promise<Run[]> {
    await this.ready();
    const params: (string | number)[] = [];
    const where: string[] = [];
    if (options?.signalName) {
      where.push(`signal_name = ?`);
      params.push(options.signalName);
    }
    if (options?.statuses && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      where.push(`status IN (${placeholders})`);
      params.push(...options.statuses);
    }
    let sql = `SELECT * FROM ${this.tableName}`;
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC`;
    sql += buildLimitOffset(options ?? {}, params);
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
    return rows.map((row) => rowToRun(row as Record<string, unknown>));
  }

  async countRunsByStatus(options?: { signalName?: string }): Promise<Partial<Record<RunStatus, number>>> {
    await this.ready();
    const params: string[] = [];
    let sql = `SELECT status, COUNT(*) AS n FROM ${this.tableName}`;
    if (options?.signalName) {
      sql += ` WHERE signal_name = ?`;
      params.push(options.signalName);
    }
    sql += ` GROUP BY status`;
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);
    const counts: Partial<Record<RunStatus, number>> = {};
    for (const row of rows) {
      const { status, n } = row as { status: RunStatus; n: number | string };
      counts[status] = Number(n);
    }
    return counts;
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
    const cutoff = dateToStr(olderThan);
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
