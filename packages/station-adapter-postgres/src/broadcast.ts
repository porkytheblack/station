import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  BroadcastQueueAdapter,
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
  DynamicBroadcastSpec,
} from "station-broadcast";

import { validateTableName, createColumnMapper, rowToObject } from "./shared.js";

const { toColumn: toBroadcastRunCol, toField: toBroadcastRunField } = createColumnMapper({
  broadcastName: "broadcast_name",
  failurePolicy: "failure_policy",
  nextRunAt: "next_run_at",
  startedAt: "started_at",
  completedAt: "completed_at",
  createdAt: "created_at",
  definitionSnapshot: "definition_snapshot",
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

export interface BroadcastPostgresAdapterOptions {
  /** PostgreSQL connection string. Ignored if `pool` is provided. */
  connectionString?: string;
  /** An existing pg.Pool instance to reuse (e.g. shared with the signal adapter). */
  pool?: pg.Pool;
  /** Table name prefix (alphanumeric and underscores only). Defaults to `"broadcast_runs"`. */
  tableName?: string;
}

export class BroadcastPostgresAdapter implements BroadcastQueueAdapter {
  private pool: pg.Pool;
  private ownsPool: boolean;
  private runsTable: string;
  private nodesTable: string;
  private definitionsTable: string;
  private initialized: Promise<void>;

  constructor(options: BroadcastPostgresAdapterOptions = {}) {
    this.runsTable = validateTableName(options.tableName ?? "broadcast_runs");
    this.nodesTable = validateTableName(`${this.runsTable}_nodes`);
    this.definitionsTable = validateTableName(`${this.runsTable}_definitions`);

    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new pg.Pool({
        connectionString: options.connectionString,
      });
      this.ownsPool = true;
    }

    this.initialized = this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.runsTable} (
        id                  TEXT PRIMARY KEY,
        broadcast_name      TEXT NOT NULL,
        input               TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        failure_policy      TEXT NOT NULL DEFAULT 'fail-fast',
        timeout             INTEGER,
        interval            TEXT,
        next_run_at         TIMESTAMPTZ,
        started_at          TIMESTAMPTZ,
        completed_at        TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL,
        error               TEXT,
        definition_snapshot TEXT
      )
    `);

    // Idempotent migration for existing databases predating dynamic broadcasts.
    await this.pool.query(`
      ALTER TABLE ${this.runsTable} ADD COLUMN IF NOT EXISTS definition_snapshot TEXT
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.runsTable}_status
        ON ${this.runsTable} (status, next_run_at)
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.runsTable}_name
        ON ${this.runsTable} (broadcast_name)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.nodesTable} (
        id                TEXT PRIMARY KEY,
        broadcast_run_id  TEXT NOT NULL REFERENCES ${this.runsTable}(id) ON DELETE CASCADE,
        node_name         TEXT NOT NULL,
        signal_name       TEXT NOT NULL,
        signal_run_id     TEXT,
        status            TEXT NOT NULL DEFAULT 'pending',
        skip_reason       TEXT,
        input             TEXT,
        output            TEXT,
        error             TEXT,
        started_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.nodesTable}_run_id
        ON ${this.nodesTable} (broadcast_run_id)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.definitionsTable} (
        name            TEXT NOT NULL,
        version         INTEGER NOT NULL,
        spec            TEXT NOT NULL,
        failure_policy  TEXT NOT NULL,
        timeout         INTEGER,
        created_at      TIMESTAMPTZ NOT NULL,
        updated_at      TIMESTAMPTZ NOT NULL,
        created_by      TEXT,
        deleted_at      TIMESTAMPTZ,
        PRIMARY KEY (name, version)
      )
    `);
  }

  private async ready(): Promise<void> {
    await this.initialized;
  }

  async addBroadcastRun(run: BroadcastRun): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.runsTable}
        (id, broadcast_name, input, status, failure_policy, timeout, interval,
         next_run_at, started_at, completed_at, created_at, error, definition_snapshot)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        run.id,
        run.broadcastName,
        run.input,
        run.status,
        run.failurePolicy,
        run.timeout ?? null,
        run.interval ?? null,
        run.nextRunAt ?? null,
        run.startedAt ?? null,
        run.completedAt ?? null,
        run.createdAt,
        run.error ?? null,
        run.definitionSnapshot ?? null,
      ],
    );
  }

  async getBroadcastRun(id: string): Promise<BroadcastRun | null> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.runsTable} WHERE id = $1`,
      [id],
    );
    return result.rows.length > 0 ? rowToBroadcastRun(result.rows[0]) : null;
  }

  private static readonly BROADCAST_RUN_PATCH_KEYS = new Set([
    "input", "status", "failurePolicy", "timeout", "interval", "nextRunAt",
    "startedAt", "completedAt", "error", "definitionSnapshot",
  ]);

  async updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(patch)) {
      if (!BroadcastPostgresAdapter.BROADCAST_RUN_PATCH_KEYS.has(key)) continue;
      const col = toBroadcastRunCol(key);
      setClauses.push(`${col} = $${paramIndex}`);
      if (value === undefined) {
        values.push(null);
      } else {
        values.push(value);
      }
      paramIndex++;
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.pool.query(
      `UPDATE ${this.runsTable} SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
      values,
    );
  }

  async getBroadcastRunsDue(): Promise<BroadcastRun[]> {
    await this.ready();
    const now = new Date();
    const result = await this.pool.query(
      `SELECT * FROM ${this.runsTable}
       WHERE status = 'pending'
         AND (next_run_at IS NULL OR next_run_at <= $1)
       ORDER BY created_at ASC`,
      [now],
    );
    return result.rows.map(rowToBroadcastRun);
  }

  async getBroadcastRunsRunning(): Promise<BroadcastRun[]> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.runsTable} WHERE status = 'running'`,
    );
    return result.rows.map(rowToBroadcastRun);
  }

  async listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.runsTable} WHERE broadcast_name = $1 ORDER BY created_at DESC`,
      [broadcastName],
    );
    return result.rows.map(rowToBroadcastRun);
  }

  async hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean> {
    await this.ready();
    if (statuses.length === 0) return false;
    const placeholders = statuses.map((_, i) => `$${i + 2}`).join(", ");
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.runsTable} WHERE broadcast_name = $1 AND status IN (${placeholders}) LIMIT 1`,
      [broadcastName, ...statuses],
    );
    return result.rows.length > 0;
  }

  async purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number> {
    await this.ready();
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map((_, i) => `$${i + 1}`).join(", ");
    const cutoffIndex = statuses.length + 1;
    const result = await this.pool.query(
      `DELETE FROM ${this.runsTable} WHERE status IN (${placeholders}) AND completed_at IS NOT NULL AND completed_at < $${cutoffIndex}`,
      [...statuses, olderThan],
    );
    return result.rowCount ?? 0;
  }

  async addNodeRun(nodeRun: BroadcastNodeRun): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.nodesTable}
        (id, broadcast_run_id, node_name, signal_name, signal_run_id,
         status, skip_reason, input, output, error, started_at, completed_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
        nodeRun.startedAt ?? null,
        nodeRun.completedAt ?? null,
      ],
    );
  }

  async getNodeRun(id: string): Promise<BroadcastNodeRun | null> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.nodesTable} WHERE id = $1`,
      [id],
    );
    return result.rows.length > 0 ? rowToNodeRun(result.rows[0]) : null;
  }

  private static readonly NODE_RUN_PATCH_KEYS = new Set([
    "signalRunId", "status", "skipReason", "input", "output", "error", "startedAt", "completedAt",
  ]);

  async updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(patch)) {
      if (!BroadcastPostgresAdapter.NODE_RUN_PATCH_KEYS.has(key)) continue;
      const col = toNodeRunCol(key);
      setClauses.push(`${col} = $${paramIndex}`);
      if (value === undefined) {
        values.push(null);
      } else {
        values.push(value);
      }
      paramIndex++;
    }

    if (setClauses.length === 0) return;

    values.push(id);
    await this.pool.query(
      `UPDATE ${this.nodesTable} SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
      values,
    );
  }

  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.nodesTable} WHERE broadcast_run_id = $1`,
      [broadcastRunId],
    );
    return result.rows.map(rowToNodeRun);
  }

  // ─── Dynamic broadcast definitions ───────────────────────────────

  async saveDefinition(spec: DynamicBroadcastSpec): Promise<DynamicBroadcastSpec> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT COALESCE(MAX(version), 0) AS v FROM ${this.definitionsTable} WHERE name = $1`,
      [spec.name],
    );
    const nextVersion = (result.rows[0]?.v ?? 0) + 1;
    const now = new Date();
    const next: DynamicBroadcastSpec = {
      ...spec,
      version: nextVersion,
      createdAt: spec.createdAt ?? now,
      updatedAt: now,
      deletedAt: undefined,
    };

    await this.pool.query(
      `INSERT INTO ${this.definitionsTable}
        (name, version, spec, failure_policy, timeout, created_at, updated_at, created_by, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
      [
        next.name,
        next.version,
        JSON.stringify(next),
        next.failurePolicy,
        next.timeout ?? null,
        next.createdAt,
        next.updatedAt,
        next.createdBy ?? null,
      ],
    );
    return next;
  }

  async getDefinition(name: string, version?: number): Promise<DynamicBroadcastSpec | null> {
    await this.ready();
    let result;
    if (version !== undefined) {
      result = await this.pool.query(
        `SELECT spec FROM ${this.definitionsTable} WHERE name = $1 AND version = $2`,
        [name, version],
      );
    } else {
      result = await this.pool.query(
        `SELECT spec FROM ${this.definitionsTable} WHERE name = $1 ORDER BY version DESC LIMIT 1`,
        [name],
      );
    }
    return result.rows.length > 0 ? deserializeSpec(result.rows[0].spec) : null;
  }

  async listDefinitions(): Promise<DynamicBroadcastSpec[]> {
    await this.ready();
    const result = await this.pool.query(`
      SELECT spec FROM ${this.definitionsTable} d1
      WHERE version = (
        SELECT MAX(version) FROM ${this.definitionsTable} d2 WHERE d2.name = d1.name
      )
      AND deleted_at IS NULL
      ORDER BY name ASC
    `);
    return result.rows.map((r: { spec: string }) => deserializeSpec(r.spec));
  }

  async listDefinitionVersions(name: string): Promise<DynamicBroadcastSpec[]> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT spec FROM ${this.definitionsTable} WHERE name = $1 ORDER BY version DESC`,
      [name],
    );
    return result.rows.map((r: { spec: string }) => deserializeSpec(r.spec));
  }

  async deleteDefinition(name: string): Promise<boolean> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT version, spec FROM ${this.definitionsTable}
       WHERE name = $1 AND deleted_at IS NULL
       ORDER BY version DESC LIMIT 1`,
      [name],
    );
    if (result.rows.length === 0) return false;
    const { version, spec } = result.rows[0];
    const parsed = deserializeSpec(spec);
    parsed.deletedAt = new Date();
    await this.pool.query(
      `UPDATE ${this.definitionsTable} SET deleted_at = $1, spec = $2 WHERE name = $3 AND version = $4`,
      [parsed.deletedAt, JSON.stringify(parsed), name, version],
    );
    return true;
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
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

function deserializeSpec(json: string): DynamicBroadcastSpec {
  const obj = JSON.parse(json) as DynamicBroadcastSpec;
  if (obj.createdAt) obj.createdAt = new Date(obj.createdAt);
  if (obj.updatedAt) obj.updatedAt = new Date(obj.updatedAt);
  if (obj.deletedAt) obj.deletedAt = new Date(obj.deletedAt);
  return obj;
}
