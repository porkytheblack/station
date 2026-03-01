import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  BroadcastQueueAdapter,
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
} from "station-broadcast";

import { validateTableName, dateToStr, createColumnMapper, rowToObject } from "./shared.js";

// ── Column mappings ────────────────────────────────────────────────────

const { toColumn: toBroadcastRunCol, toField: toBroadcastRunField } = createColumnMapper({
  broadcastName: "broadcast_name",
  failurePolicy: "failure_policy",
  nextRunAt: "next_run_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  createdAt: "created_at",
});
const BROADCAST_RUN_DATE_FIELDS = new Set(["nextRunAt", "startedAt", "completedAt", "createdAt"]);

const { toColumn: toNodeRunCol, toField: toNodeRunField } = createColumnMapper({
  broadcastRunId: "broadcast_run_id",
  nodeName: "node_name",
  signalName: "signal_name",
  signalRunId: "signal_run_id",
  skipReason: "skip_reason",
  startedAt: "started_at",
  completedAt: "completed_at",
});
const NODE_RUN_DATE_FIELDS = new Set(["startedAt", "completedAt"]);

function rowToBroadcastRun(row: Record<string, unknown>): BroadcastRun {
  return rowToObject<BroadcastRun>(row, toBroadcastRunField, BROADCAST_RUN_DATE_FIELDS);
}
function rowToNodeRun(row: Record<string, unknown>): BroadcastNodeRun {
  return rowToObject<BroadcastNodeRun>(row, toNodeRunField, NODE_RUN_DATE_FIELDS);
}

// ── Options ────────────────────────────────────────────────────────────

export interface BroadcastMysqlAdapterOptions {
  /** MySQL connection string (e.g. "mysql://user:pass@host:3306/db"). */
  connectionString?: string;
  /** Existing mysql2 connection pool. Takes precedence over connectionString. */
  pool?: Pool;
  /** Table name prefix for broadcast runs (alphanumeric and underscores only). Defaults to "broadcast_runs". */
  tableName?: string;
}

// ── Adapter ────────────────────────────────────────────────────────────

export class BroadcastMysqlAdapter implements BroadcastQueueAdapter {
  private pool: Pool;
  private runsTable: string;
  private nodesTable: string;
  private ownsPool: boolean;

  private constructor(pool: Pool, runsTable: string, nodesTable: string, ownsPool: boolean) {
    this.pool = pool;
    this.runsTable = runsTable;
    this.nodesTable = nodesTable;
    this.ownsPool = ownsPool;
  }

  /**
   * Create a new BroadcastMysqlAdapter. Table creation is async, so this
   * is the only way to construct the adapter.
   */
  static async create(options: BroadcastMysqlAdapterOptions = {}): Promise<BroadcastMysqlAdapter> {
    const runsTable = validateTableName(options.tableName ?? "broadcast_runs");
    const nodesTable = validateTableName(`${runsTable}_nodes`);

    let pool: Pool;
    let ownsPool: boolean;

    if (options.pool) {
      pool = options.pool;
      ownsPool = false;
    } else {
      const uri = options.connectionString;
      if (!uri) {
        throw new Error(
          "BroadcastMysqlAdapter requires either a connectionString or an existing pool.",
        );
      }
      pool = mysql.createPool(uri);
      ownsPool = true;
    }

    // Create broadcast_runs table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${runsTable} (
        id              VARCHAR(36) PRIMARY KEY,
        broadcast_name  VARCHAR(255) NOT NULL,
        input           TEXT NOT NULL,
        status          VARCHAR(50) NOT NULL DEFAULT 'pending',
        failure_policy  VARCHAR(50) NOT NULL DEFAULT 'fail-fast',
        timeout         INT,
        \`interval\`    VARCHAR(255),
        next_run_at     DATETIME(3),
        started_at      DATETIME(3),
        completed_at    DATETIME(3),
        created_at      DATETIME(3) NOT NULL,
        error           TEXT
      )
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_${runsTable}_status
        ON ${runsTable} (status, next_run_at)
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_${runsTable}_name
        ON ${runsTable} (broadcast_name)
    `);

    // Create broadcast_runs_nodes table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${nodesTable} (
        id                VARCHAR(36) PRIMARY KEY,
        broadcast_run_id  VARCHAR(36) NOT NULL,
        node_name         VARCHAR(255) NOT NULL,
        signal_name       VARCHAR(255) NOT NULL,
        signal_run_id     VARCHAR(36),
        status            VARCHAR(50) NOT NULL DEFAULT 'pending',
        skip_reason       VARCHAR(50),
        input             TEXT,
        output            TEXT,
        error             TEXT,
        started_at        DATETIME(3),
        completed_at      DATETIME(3),
        CONSTRAINT fk_${nodesTable}_run_id
          FOREIGN KEY (broadcast_run_id) REFERENCES ${runsTable}(id) ON DELETE CASCADE
      )
    `);

    await pool.execute(`
      CREATE INDEX IF NOT EXISTS idx_${nodesTable}_run_id
        ON ${nodesTable} (broadcast_run_id)
    `);

    return new BroadcastMysqlAdapter(pool, runsTable, nodesTable, ownsPool);
  }

  // ── Broadcast run methods ──────────────────────────────────────────────

  async addBroadcastRun(run: BroadcastRun): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.runsTable}
        (id, broadcast_name, input, status, failure_policy, timeout, \`interval\`,
         next_run_at, started_at, completed_at, created_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.broadcastName,
        run.input,
        run.status,
        run.failurePolicy,
        run.timeout ?? null,
        run.interval ?? null,
        dateToStr(run.nextRunAt),
        dateToStr(run.startedAt),
        dateToStr(run.completedAt),
        dateToStr(run.createdAt),
        run.error ?? null,
      ],
    );
  }

  async getBroadcastRun(id: string): Promise<BroadcastRun | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.runsTable} WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToBroadcastRun(rows[0] as Record<string, unknown>);
  }

  /** Allowed BroadcastRunPatch keys — whitelist to prevent injection. */
  private static readonly BROADCAST_RUN_PATCH_KEYS = new Set([
    "input", "status", "failurePolicy", "timeout", "interval", "nextRunAt",
    "startedAt", "completedAt", "error",
  ]);

  async updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!BroadcastMysqlAdapter.BROADCAST_RUN_PATCH_KEYS.has(key)) continue;
      const col = toBroadcastRunCol(key);
      const quotedCol = col === "interval" ? "`interval`" : col;
      setClauses.push(`${quotedCol} = ?`);
      if (value === undefined) {
        values.push(null);
      } else if (BROADCAST_RUN_DATE_FIELDS.has(key)) {
        values.push(dateToStr(value));
      } else {
        values.push(value as string | number);
      }
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.pool.execute(
      `UPDATE ${this.runsTable} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  async getBroadcastRunsDue(): Promise<BroadcastRun[]> {
    const now = new Date().toISOString();
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.runsTable}
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY created_at ASC`,
      [now],
    );
    return rows.map((row) => rowToBroadcastRun(row as Record<string, unknown>));
  }

  async getBroadcastRunsRunning(): Promise<BroadcastRun[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.runsTable} WHERE status = 'running'`,
    );
    return rows.map((row) => rowToBroadcastRun(row as Record<string, unknown>));
  }

  async listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.runsTable} WHERE broadcast_name = ? ORDER BY created_at DESC`,
      [broadcastName],
    );
    return rows.map((row) => rowToBroadcastRun(row as Record<string, unknown>));
  }

  async hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => "?").join(", ");
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM ${this.runsTable} WHERE broadcast_name = ? AND status IN (${placeholders}) LIMIT 1`,
      [broadcastName, ...statuses],
    );
    return rows.length > 0;
  }

  async purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const cutoff = olderThan.toISOString();
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM ${this.runsTable} WHERE status IN (${placeholders}) AND completed_at IS NOT NULL AND completed_at < ?`,
      [...statuses, cutoff],
    );
    return result.affectedRows;
  }

  // ── Node run methods ───────────────────────────────────────────────────

  async addNodeRun(nodeRun: BroadcastNodeRun): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.nodesTable}
        (id, broadcast_run_id, node_name, signal_name, signal_run_id,
         status, skip_reason, input, output, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nodeRun.id,
        nodeRun.broadcastRunId,
        nodeRun.nodeName,
        nodeRun.signalName,
        nodeRun.signalRunId ?? null,
        nodeRun.status,
        nodeRun.skipReason ?? null,
        nodeRun.input ?? null,
        nodeRun.output ?? null,
        nodeRun.error ?? null,
        dateToStr(nodeRun.startedAt),
        dateToStr(nodeRun.completedAt),
      ],
    );
  }

  async getNodeRun(id: string): Promise<BroadcastNodeRun | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.nodesTable} WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToNodeRun(rows[0] as Record<string, unknown>);
  }

  /** Allowed BroadcastNodeRunPatch keys. */
  private static readonly NODE_RUN_PATCH_KEYS = new Set([
    "signalRunId", "status", "skipReason", "input", "output", "error", "startedAt", "completedAt",
  ]);

  async updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(patch)) {
      if (!BroadcastMysqlAdapter.NODE_RUN_PATCH_KEYS.has(key)) continue;
      const col = toNodeRunCol(key);
      setClauses.push(`${col} = ?`);
      if (value === undefined) {
        values.push(null);
      } else if (NODE_RUN_DATE_FIELDS.has(key)) {
        values.push(dateToStr(value));
      } else {
        values.push(value as string | number);
      }
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.pool.execute(
      `UPDATE ${this.nodesTable} SET ${setClauses.join(", ")} WHERE id = ?`,
      values,
    );
  }

  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.nodesTable} WHERE broadcast_run_id = ?`,
      [broadcastRunId],
    );
    return rows.map((row) => rowToNodeRun(row as Record<string, unknown>));
  }

  // ── Utility ────────────────────────────────────────────────────────────

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.execute("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }
}
