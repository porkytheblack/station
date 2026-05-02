import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  Schedule,
  SchedulePatch,
  ScheduleAdapter,
  ScheduleListFilter,
} from "station-schedules";
import { validateTableName, dateToStr, toDate, runIdempotentDdl } from "./shared.js";

export interface ScheduleMysqlAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  tableName?: string;
}

export class ScheduleMysqlAdapter implements ScheduleAdapter {
  private pool: Pool;
  private table: string;
  private ownsPool: boolean;

  private constructor(pool: Pool, table: string, ownsPool: boolean) {
    this.pool = pool;
    this.table = table;
    this.ownsPool = ownsPool;
  }

  static async create(options: ScheduleMysqlAdapterOptions = {}): Promise<ScheduleMysqlAdapter> {
    const table = validateTableName(options.tableName ?? "schedules");
    let pool: Pool;
    let ownsPool: boolean;
    if (options.pool) {
      pool = options.pool;
      ownsPool = false;
    } else {
      if (!options.connectionString) {
        throw new Error("ScheduleMysqlAdapter requires a connectionString or an existing pool.");
      }
      pool = mysql.createPool(options.connectionString);
      ownsPool = true;
    }

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id              VARCHAR(36) PRIMARY KEY,
        kind            VARCHAR(50) NOT NULL,
        target          VARCHAR(255) NOT NULL,
        \`interval\`    VARCHAR(255) NOT NULL,
        input           TEXT,
        enabled         TINYINT NOT NULL DEFAULT 1,
        next_run_at     DATETIME(3) NOT NULL,
        last_run_at     DATETIME(3),
        last_run_status VARCHAR(50),
        last_run_id     VARCHAR(36),
        created_at      DATETIME(3) NOT NULL,
        updated_at      DATETIME(3) NOT NULL,
        created_by      VARCHAR(255)
      )
    `);
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${table}_due ON ${table} (enabled, next_run_at)`,
    );

    return new ScheduleMysqlAdapter(pool, table, ownsPool);
  }

  async add(schedule: Schedule): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.table}
        (id, kind, target, \`interval\`, input, enabled, next_run_at,
         last_run_at, last_run_status, last_run_id,
         created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        schedule.id,
        schedule.kind,
        schedule.target,
        schedule.interval,
        schedule.input !== undefined ? JSON.stringify(schedule.input) : null,
        schedule.enabled ? 1 : 0,
        dateToStr(schedule.nextRunAt),
        dateToStr(schedule.lastRunAt),
        schedule.lastRunStatus ?? null,
        schedule.lastRunId ?? null,
        dateToStr(schedule.createdAt),
        dateToStr(schedule.updatedAt),
        schedule.createdBy ?? null,
      ],
    );
  }

  async get(id: string): Promise<Schedule | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? rowToSchedule(rows[0] as Record<string, unknown>) : null;
  }

  async list(filter?: ScheduleListFilter): Promise<Schedule[]> {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];
    if (filter?.kind) {
      conditions.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter?.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(filter.enabled ? 1 : 0);
    }
    if (filter?.due) {
      conditions.push("enabled = 1");
      conditions.push("next_run_at <= ?");
      params.push(dateToStr(new Date()));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} ${where} ORDER BY next_run_at ASC`,
      params,
    );
    return rows.map((r) => rowToSchedule(r as Record<string, unknown>));
  }

  async update(id: string, patch: SchedulePatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];
    const map: Record<string, string> = {
      interval: "`interval`",
      input: "input",
      enabled: "enabled",
      nextRunAt: "next_run_at",
      lastRunAt: "last_run_at",
      lastRunStatus: "last_run_status",
      lastRunId: "last_run_id",
      updatedAt: "updated_at",
      createdBy: "created_by",
    };
    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      const col = map[key];
      if (!col) continue;
      touched = true;
      setClauses.push(`${col} = ?`);
      if (value === undefined) values.push(null);
      else if (key === "input") values.push(JSON.stringify(value));
      else if (key === "enabled") values.push(value ? 1 : 0);
      else if (key === "nextRunAt" || key === "lastRunAt" || key === "updatedAt") values.push(dateToStr(value));
      else values.push(value as string | number);
    }
    if (touched && !("updatedAt" in patch)) {
      setClauses.push("updated_at = ?");
      values.push(dateToStr(new Date()));
    }
    if (setClauses.length === 0) return;
    values.push(id);
    await this.pool.execute(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE id = ?`, values);
  }

  async delete(id: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `DELETE FROM ${this.table} WHERE id = ?`,
      [id],
    );
    return result.affectedRows > 0;
  }

  /**
   * Atomic claim — `UPDATE ... WHERE next_run_at = ?` is atomic in MySQL,
   * and `affectedRows` reports whether any row matched. Multi-instance safe.
   */
  async claimDue(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE ${this.table}
       SET next_run_at = ?, updated_at = ?
       WHERE id = ? AND next_run_at = ? AND enabled = 1`,
      [
        dateToStr(newNextRunAt),
        dateToStr(new Date()),
        id,
        dateToStr(expectedNextRunAt),
      ],
    );
    return result.affectedRows > 0;
  }

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

function rowToSchedule(row: Record<string, unknown>): Schedule {
  return {
    id: row.id as string,
    kind: row.kind as Schedule["kind"],
    target: row.target as string,
    interval: row.interval as string,
    input: row.input ? JSON.parse(row.input as string) : undefined,
    enabled: Boolean(row.enabled),
    nextRunAt: toDate(row.next_run_at)!,
    lastRunAt: toDate(row.last_run_at),
    lastRunStatus: (row.last_run_status as string | null) ?? undefined,
    lastRunId: (row.last_run_id as string | null) ?? undefined,
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
    createdBy: (row.created_by as string | null) ?? undefined,
  };
}
