import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  Schedule,
  SchedulePatch,
  ScheduleAdapter,
  ScheduleListFilter,
} from "station-schedules";
import { validateTableName } from "./shared.js";

export interface SchedulePostgresAdapterOptions {
  connectionString?: string;
  pool?: pg.Pool;
  tableName?: string;
}

export class SchedulePostgresAdapter implements ScheduleAdapter {
  private pool: pg.Pool;
  private ownsPool: boolean;
  private table: string;
  private initialized: Promise<void>;

  constructor(options: SchedulePostgresAdapterOptions = {}) {
    this.table = validateTableName(options.tableName ?? "schedules");
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new pg.Pool({ connectionString: options.connectionString });
      this.ownsPool = true;
    }
    this.initialized = this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        target          TEXT NOT NULL,
        interval        TEXT NOT NULL,
        input           TEXT,
        enabled         BOOLEAN NOT NULL DEFAULT TRUE,
        next_run_at     TIMESTAMPTZ NOT NULL,
        last_run_at     TIMESTAMPTZ,
        last_run_status TEXT,
        last_run_id     TEXT,
        created_at      TIMESTAMPTZ NOT NULL,
        updated_at      TIMESTAMPTZ NOT NULL,
        created_by      TEXT
        ,cron           TEXT
        ,timezone       TEXT
        ,overlap_policy TEXT
        ,misfire_policy TEXT
        ,misfire_grace_ms INTEGER
      )
    `);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS cron TEXT`);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS timezone TEXT`);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS overlap_policy TEXT`);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS misfire_policy TEXT`);
    await this.pool.query(`ALTER TABLE ${this.table} ADD COLUMN IF NOT EXISTS misfire_grace_ms INTEGER`);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_due
        ON ${this.table} (enabled, next_run_at)
    `);
  }

  private async ready(): Promise<void> {
    await this.initialized;
  }

  async add(schedule: Schedule): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.table}
        (id, kind, target, interval, input, enabled, next_run_at,
         last_run_at, last_run_status, last_run_id,
         created_at, updated_at, created_by, cron, timezone, overlap_policy, misfire_policy, misfire_grace_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        schedule.id,
        schedule.kind,
        schedule.target,
        schedule.interval ?? "",
        schedule.input !== undefined ? JSON.stringify(schedule.input) : null,
        schedule.enabled,
        schedule.nextRunAt,
        schedule.lastRunAt ?? null,
        schedule.lastRunStatus ?? null,
        schedule.lastRunId ?? null,
        schedule.createdAt,
        schedule.updatedAt,
        schedule.createdBy ?? null,
        schedule.cron ?? null,
        schedule.timezone ?? null,
        schedule.overlapPolicy ?? null,
        schedule.misfirePolicy ?? null,
        schedule.misfireGraceMs ?? null,
      ],
    );
  }

  async get(id: string): Promise<Schedule | null> {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return result.rows.length > 0 ? rowToSchedule(result.rows[0]) : null;
  }

  async list(filter?: ScheduleListFilter): Promise<Schedule[]> {
    await this.ready();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (filter?.kind) {
      conditions.push(`kind = $${i++}`);
      params.push(filter.kind);
    }
    if (filter?.enabled !== undefined) {
      conditions.push(`enabled = $${i++}`);
      params.push(filter.enabled);
    }
    if (filter?.due) {
      conditions.push("enabled = TRUE");
      conditions.push(`next_run_at <= $${i++}`);
      params.push(new Date());
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} ${where} ORDER BY next_run_at ASC`,
      params,
    );
    return result.rows.map(rowToSchedule);
  }

  async update(id: string, patch: SchedulePatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const map: Record<string, string> = {
      interval: "interval",
      input: "input",
      enabled: "enabled",
      nextRunAt: "next_run_at",
      lastRunAt: "last_run_at",
      lastRunStatus: "last_run_status",
      lastRunId: "last_run_id",
      updatedAt: "updated_at",
      createdBy: "created_by",
      cron: "cron",
      timezone: "timezone",
      overlapPolicy: "overlap_policy",
      misfirePolicy: "misfire_policy",
      misfireGraceMs: "misfire_grace_ms",
    };

    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      const col = map[key];
      if (!col) continue;
      touched = true;
      setClauses.push(`${col} = $${i++}`);
      if (value === undefined) values.push(key === "interval" ? "" : null);
      else if (key === "input") values.push(JSON.stringify(value));
      else values.push(value);
    }
    if (touched && !("updatedAt" in patch)) {
      setClauses.push(`updated_at = $${i++}`);
      values.push(new Date());
    }
    if (setClauses.length === 0) return;
    values.push(id);
    await this.pool.query(
      `UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE id = $${i}`,
      values,
    );
  }

  async delete(id: string): Promise<boolean> {
    await this.ready();
    const result = await this.pool.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Atomic claim — relies on Postgres' `UPDATE ... RETURNING` to ensure only
   * one worker advances the schedule. Multiple runners against the same
   * database will not double-fire.
   */
  async claimDue(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean> {
    await this.ready();
    const result = await this.pool.query(
      `UPDATE ${this.table}
       SET next_run_at = $1, updated_at = $2
       WHERE id = $3 AND next_run_at = $4 AND enabled = TRUE
       RETURNING id`,
      [newNextRunAt, new Date(), id, expectedNextRunAt],
    );
    return (result.rowCount ?? 0) > 0;
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

function rowToSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: row.id as string,
    kind: row.kind as Schedule["kind"],
    target: row.target as string,
    interval: row.interval ? row.interval as string : undefined,
    cron: (row.cron as string | null) ?? undefined,
    timezone: (row.timezone as string | null) ?? undefined,
    overlapPolicy: (row.overlap_policy as Schedule["overlapPolicy"] | null) ?? undefined,
    misfirePolicy: (row.misfire_policy as Schedule["misfirePolicy"] | null) ?? undefined,
    misfireGraceMs: (row.misfire_grace_ms as number | null) ?? undefined,
    input: row.input ? JSON.parse(row.input as string) : undefined,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at as Date,
    lastRunAt: (row.last_run_at as Date | null) ?? undefined,
    lastRunStatus: (row.last_run_status as string | null) ?? undefined,
    lastRunId: (row.last_run_id as string | null) ?? undefined,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    createdBy: (row.created_by as string | null) ?? undefined,
  };
}
