import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  BroadcastQueueAdapter,
  BroadcastRun,
  BroadcastRunPatch,
  BroadcastRunStatus,
  BroadcastNodeRun,
  BroadcastNodeRunPatch,
  DynamicBroadcastSpec,
} from "station-broadcast";

import { validateTableName, dateToStr, createColumnMapper, rowToObject } from "./shared.js";

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

export interface BroadcastSqliteAdapterOptions {
  dbPath?: string;
  tableName?: string;
}

export class BroadcastSqliteAdapter implements BroadcastQueueAdapter {
  private db: Database.Database;
  private runsTable: string;
  private nodesTable: string;
  private definitionsTable: string;
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

  constructor(options: BroadcastSqliteAdapterOptions = {}) {
    const dbPath = options.dbPath ?? "station.db";
    this.runsTable = validateTableName(options.tableName ?? "broadcast_runs");
    this.nodesTable = validateTableName(`${this.runsTable}_nodes`);
    this.definitionsTable = validateTableName(`${this.runsTable}_definitions`);
    this.db = new Database(dbPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.runsTable} (
        id                  TEXT PRIMARY KEY,
        broadcast_name      TEXT NOT NULL,
        input               TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'pending',
        failure_policy      TEXT NOT NULL DEFAULT 'fail-fast',
        timeout             INTEGER,
        interval            TEXT,
        next_run_at         TEXT,
        started_at          TEXT,
        completed_at        TEXT,
        created_at          TEXT NOT NULL,
        error               TEXT,
        definition_snapshot TEXT
      )
    `);

    // Idempotent migration: add column if it's missing (DB existed before this version).
    const existingCols = this
      .prep(`PRAGMA table_info(${this.runsTable})`)
      .all() as Array<{ name: string }>;
    if (!existingCols.some((c) => c.name === "definition_snapshot")) {
      this.db.exec(`ALTER TABLE ${this.runsTable} ADD COLUMN definition_snapshot TEXT`);
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.runsTable}_status
        ON ${this.runsTable} (status, next_run_at)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.runsTable}_name
        ON ${this.runsTable} (broadcast_name)
    `);

    this.db.exec(`
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
        started_at        TEXT,
        completed_at      TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.nodesTable}_run_id
        ON ${this.nodesTable} (broadcast_run_id)
    `);

    // Dynamic broadcast definitions — name + version is the identity, full
    // history is retained so deleted/older versions remain inspectable.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.definitionsTable} (
        name            TEXT NOT NULL,
        version         INTEGER NOT NULL,
        spec            TEXT NOT NULL,
        failure_policy  TEXT NOT NULL,
        timeout         INTEGER,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        created_by      TEXT,
        deleted_at      TEXT,
        PRIMARY KEY (name, version)
      )
    `);
  }

  async addBroadcastRun(run: BroadcastRun): Promise<void> {
    this.prep(`
      INSERT INTO ${this.runsTable}
        (id, broadcast_name, input, status, failure_policy, timeout, interval,
         next_run_at, started_at, completed_at, created_at, error, definition_snapshot)
      VALUES
        (@id, @broadcast_name, @input, @status, @failure_policy, @timeout, @interval,
         @next_run_at, @started_at, @completed_at, @created_at, @error, @definition_snapshot)
    `).run({
      id: run.id,
      broadcast_name: run.broadcastName,
      input: run.input,
      status: run.status,
      failure_policy: run.failurePolicy,
      timeout: run.timeout ?? null,
      interval: run.interval ?? null,
      next_run_at: dateToStr(run.nextRunAt),
      started_at: dateToStr(run.startedAt),
      completed_at: dateToStr(run.completedAt),
      created_at: dateToStr(run.createdAt),
      error: run.error ?? null,
      definition_snapshot: run.definitionSnapshot ?? null,
    });
  }

  async getBroadcastRun(id: string): Promise<BroadcastRun | null> {
    const row = this.prep(`SELECT * FROM ${this.runsTable} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToBroadcastRun(row) : null;
  }

  private static readonly BROADCAST_RUN_PATCH_KEYS = new Set([
    "input", "status", "failurePolicy", "timeout", "interval", "nextRunAt",
    "startedAt", "completedAt", "error", "definitionSnapshot",
  ]);

  async updateBroadcastRun(id: string, patch: BroadcastRunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      if (!BroadcastSqliteAdapter.BROADCAST_RUN_PATCH_KEYS.has(key)) continue;
      const col = toBroadcastRunCol(key);
      const param = `p_${col}`;
      setClauses.push(`${col} = @${param}`);
      if (value === undefined) {
        values[param] = null;
      } else {
        values[param] = BROADCAST_RUN_DATE_FIELDS.has(key) ? dateToStr(value) : value;
      }
    }

    if (setClauses.length === 0) return;
    this.prep(`UPDATE ${this.runsTable} SET ${setClauses.join(", ")} WHERE id = @id`).run(values);
  }

  async getBroadcastRunsDue(): Promise<BroadcastRun[]> {
    const now = new Date().toISOString();
    const rows = this.prep(`
      SELECT * FROM ${this.runsTable}
      WHERE status = 'pending'
        AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY created_at ASC
    `).all(now) as Record<string, unknown>[];
    return rows.map(rowToBroadcastRun);
  }

  async getBroadcastRunsRunning(): Promise<BroadcastRun[]> {
    const rows = this.prep(`SELECT * FROM ${this.runsTable} WHERE status = 'running'`).all() as Record<string, unknown>[];
    return rows.map(rowToBroadcastRun);
  }

  async listBroadcastRuns(broadcastName: string): Promise<BroadcastRun[]> {
    const rows = this.prep(`SELECT * FROM ${this.runsTable} WHERE broadcast_name = ? ORDER BY created_at DESC`).all(broadcastName) as Record<string, unknown>[];
    return rows.map(rowToBroadcastRun);
  }

  async hasBroadcastRunWithStatus(broadcastName: string, statuses: BroadcastRunStatus[]): Promise<boolean> {
    if (statuses.length === 0) return false;
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.prep(
      `SELECT 1 FROM ${this.runsTable} WHERE broadcast_name = ? AND status IN (${placeholders}) LIMIT 1`,
    ).get(broadcastName, ...statuses);
    return row !== undefined;
  }

  async purgeBroadcastRuns(olderThan: Date, statuses: BroadcastRunStatus[]): Promise<number> {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => "?").join(", ");
    const cutoff = olderThan.toISOString();
    const result = this.prep(
      `DELETE FROM ${this.runsTable} WHERE status IN (${placeholders}) AND completed_at IS NOT NULL AND completed_at < ?`,
    ).run(...statuses, cutoff);
    return result.changes;
  }

  async addNodeRun(nodeRun: BroadcastNodeRun): Promise<void> {
    this.prep(`
      INSERT INTO ${this.nodesTable}
        (id, broadcast_run_id, node_name, signal_name, signal_run_id,
         status, skip_reason, input, output, error, started_at, completed_at)
      VALUES
        (@id, @broadcast_run_id, @node_name, @signal_name, @signal_run_id,
         @status, @skip_reason, @input, @output, @error, @started_at, @completed_at)
    `).run({
      id: nodeRun.id,
      broadcast_run_id: nodeRun.broadcastRunId,
      node_name: nodeRun.nodeName,
      signal_name: nodeRun.signalName,
      signal_run_id: nodeRun.signalRunId ?? null,
      status: nodeRun.status,
      skip_reason: nodeRun.skipReason ?? null,
      input: nodeRun.input ?? null,
      output: nodeRun.output ?? null,
      error: nodeRun.error ?? null,
      started_at: dateToStr(nodeRun.startedAt),
      completed_at: dateToStr(nodeRun.completedAt),
    });
  }

  async getNodeRun(id: string): Promise<BroadcastNodeRun | null> {
    const row = this.prep(`SELECT * FROM ${this.nodesTable} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToNodeRun(row) : null;
  }

  private static readonly NODE_RUN_PATCH_KEYS = new Set([
    "signalRunId", "status", "skipReason", "input", "output", "error", "startedAt", "completedAt",
  ]);

  async updateNodeRun(id: string, patch: BroadcastNodeRunPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };

    for (const [key, value] of Object.entries(patch)) {
      if (!BroadcastSqliteAdapter.NODE_RUN_PATCH_KEYS.has(key)) continue;
      const col = toNodeRunCol(key);
      const param = `p_${col}`;
      setClauses.push(`${col} = @${param}`);
      if (value === undefined) {
        values[param] = null;
      } else {
        values[param] = NODE_RUN_DATE_FIELDS.has(key) ? dateToStr(value) : value;
      }
    }

    if (setClauses.length === 0) return;
    this.prep(`UPDATE ${this.nodesTable} SET ${setClauses.join(", ")} WHERE id = @id`).run(values);
  }

  async getNodeRuns(broadcastRunId: string): Promise<BroadcastNodeRun[]> {
    const rows = this.prep(`SELECT * FROM ${this.nodesTable} WHERE broadcast_run_id = ?`).all(broadcastRunId) as Record<string, unknown>[];
    return rows.map(rowToNodeRun);
  }

  // ─── Dynamic broadcast definitions ───────────────────────────────

  async saveDefinition(spec: DynamicBroadcastSpec): Promise<DynamicBroadcastSpec> {
    // better-sqlite3 transactions serialize writers, so the MAX(version) read
    // + INSERT can't be interleaved with another save — no PK collision is
    // possible on the same DB. The transaction wrapper handles SAVEPOINTs
    // for nested calls.
    const txn = this.db.transaction((spec: DynamicBroadcastSpec): DynamicBroadcastSpec => {
      const row = this
        .prep(`SELECT MAX(version) AS v FROM ${this.definitionsTable} WHERE name = ?`)
        .get(spec.name) as { v: number | null } | undefined;
      const nextVersion = (row?.v ?? 0) + 1;
      const now = new Date();
      const next: DynamicBroadcastSpec = {
        ...spec,
        version: nextVersion,
        createdAt: spec.createdAt ?? now,
        updatedAt: now,
        deletedAt: undefined,
      };
      this
        .prep(`
          INSERT INTO ${this.definitionsTable}
            (name, version, spec, failure_policy, timeout, created_at, updated_at, created_by, deleted_at)
          VALUES
            (@name, @version, @spec, @failure_policy, @timeout, @created_at, @updated_at, @created_by, NULL)
        `)
        .run({
          name: next.name,
          version: next.version,
          spec: JSON.stringify(next),
          failure_policy: next.failurePolicy,
          timeout: next.timeout ?? null,
          created_at: dateToStr(next.createdAt),
          updated_at: dateToStr(next.updatedAt),
          created_by: next.createdBy ?? null,
        });
      return next;
    });
    return txn(spec);
  }

  async getDefinition(name: string, version?: number): Promise<DynamicBroadcastSpec | null> {
    let row: { spec: string } | undefined;
    if (version !== undefined) {
      row = this
        .prep(`SELECT spec FROM ${this.definitionsTable} WHERE name = ? AND version = ?`)
        .get(name, version) as { spec: string } | undefined;
    } else {
      row = this
        .prep(`SELECT spec FROM ${this.definitionsTable} WHERE name = ? ORDER BY version DESC LIMIT 1`)
        .get(name) as { spec: string } | undefined;
    }
    return row ? deserializeSpec(row.spec) : null;
  }

  async listDefinitions(): Promise<DynamicBroadcastSpec[]> {
    const rows = this
      .prep(`
        SELECT spec FROM ${this.definitionsTable} d1
        WHERE version = (
          SELECT MAX(version) FROM ${this.definitionsTable} d2 WHERE d2.name = d1.name
        )
        AND deleted_at IS NULL
        ORDER BY name ASC
      `)
      .all() as Array<{ spec: string }>;
    return rows.map((r) => deserializeSpec(r.spec));
  }

  async listDefinitionVersions(name: string): Promise<DynamicBroadcastSpec[]> {
    const rows = this
      .prep(`SELECT spec FROM ${this.definitionsTable} WHERE name = ? ORDER BY version DESC`)
      .all(name) as Array<{ spec: string }>;
    return rows.map((r) => deserializeSpec(r.spec));
  }

  async deleteDefinition(name: string): Promise<boolean> {
    const row = this
      .prep(`SELECT MAX(version) AS v FROM ${this.definitionsTable} WHERE name = ? AND deleted_at IS NULL`)
      .get(name) as { v: number | null } | undefined;
    if (!row?.v) return false;
    const now = new Date().toISOString();
    // Update the spec JSON with the deletion timestamp so consumers see it.
    const existing = this
      .prep(`SELECT spec FROM ${this.definitionsTable} WHERE name = ? AND version = ?`)
      .get(name, row.v) as { spec: string } | undefined;
    if (!existing) return false;
    const spec = deserializeSpec(existing.spec);
    spec.deletedAt = new Date(now);
    this
      .prep(`UPDATE ${this.definitionsTable} SET deleted_at = ?, spec = ? WHERE name = ? AND version = ?`)
      .run(now, JSON.stringify(spec), name, row.v);
    return true;
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      this.prep("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.stmtCache.clear();
    this.db.close();
  }
}

function deserializeSpec(json: string): DynamicBroadcastSpec {
  const obj = JSON.parse(json) as DynamicBroadcastSpec;
  // Revive Date fields
  if (obj.createdAt) obj.createdAt = new Date(obj.createdAt);
  if (obj.updatedAt) obj.updatedAt = new Date(obj.updatedAt);
  if (obj.deletedAt) obj.deletedAt = new Date(obj.deletedAt);
  return obj;
}
