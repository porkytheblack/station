import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  Schedule,
  SchedulePatch,
  ScheduleAdapter,
  ScheduleListFilter,
} from "station-schedules";
import { validateTableName, dateToStr, strToDate } from "./shared.js";

export interface ScheduleSqliteAdapterOptions {
  dbPath?: string;
  tableName?: string;
}

export class ScheduleSqliteAdapter implements ScheduleAdapter {
  private db: Database.Database;
  private table: string;

  constructor(options: ScheduleSqliteAdapterOptions = {}) {
    const dbPath = options.dbPath ?? "station.db";
    this.table = validateTableName(options.tableName ?? "schedules");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        target          TEXT NOT NULL,
        interval        TEXT NOT NULL,
        input           TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        next_run_at     TEXT NOT NULL,
        last_run_at     TEXT,
        last_run_status TEXT,
        last_run_id     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        created_by      TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_due
        ON ${this.table} (enabled, next_run_at)
    `);
  }

  async add(schedule: Schedule): Promise<void> {
    this.db.prepare(`
      INSERT INTO ${this.table}
        (id, kind, target, interval, input, enabled, next_run_at,
         last_run_at, last_run_status, last_run_id,
         created_at, updated_at, created_by)
      VALUES
        (@id, @kind, @target, @interval, @input, @enabled, @next_run_at,
         @last_run_at, @last_run_status, @last_run_id,
         @created_at, @updated_at, @created_by)
    `).run({
      id: schedule.id,
      kind: schedule.kind,
      target: schedule.target,
      interval: schedule.interval,
      input: schedule.input !== undefined ? JSON.stringify(schedule.input) : null,
      enabled: schedule.enabled ? 1 : 0,
      next_run_at: dateToStr(schedule.nextRunAt),
      last_run_at: dateToStr(schedule.lastRunAt),
      last_run_status: schedule.lastRunStatus ?? null,
      last_run_id: schedule.lastRunId ?? null,
      created_at: dateToStr(schedule.createdAt),
      updated_at: dateToStr(schedule.updatedAt),
      created_by: schedule.createdBy ?? null,
    });
  }

  async get(id: string): Promise<Schedule | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSchedule(row) : null;
  }

  async list(filter?: ScheduleListFilter): Promise<Schedule[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
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
      params.push(new Date().toISOString());
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM ${this.table} ${where} ORDER BY next_run_at ASC`).all(...params) as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }

  async update(id: string, patch: SchedulePatch): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };
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
    };

    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      const col = map[key];
      if (!col) continue;
      touched = true;
      const param = `p_${col}`;
      setClauses.push(`${col} = @${param}`);
      if (value === undefined) {
        values[param] = null;
      } else if (key === "input") {
        values[param] = JSON.stringify(value);
      } else if (key === "enabled") {
        values[param] = value ? 1 : 0;
      } else if (key === "nextRunAt" || key === "lastRunAt" || key === "updatedAt") {
        values[param] = dateToStr(value);
      } else {
        values[param] = value;
      }
    }

    // Always bump updated_at on update
    if (touched && !("updatedAt" in patch)) {
      setClauses.push("updated_at = @p_updated_at");
      values.p_updated_at = new Date().toISOString();
    }

    if (setClauses.length === 0) return;
    this.db.prepare(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE id = @id`).run(values);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /**
   * Atomic claim — only update if the schedule's nextRunAt is still what we
   * expected. Prevents two runners from double-firing the same schedule.
   */
  async claimDue(id: string, expectedNextRunAt: Date, newNextRunAt: Date): Promise<boolean> {
    const result = this.db
      .prepare(`UPDATE ${this.table}
                SET next_run_at = @new_next, updated_at = @now
                WHERE id = @id AND next_run_at = @expected AND enabled = 1`)
      .run({
        id,
        new_next: dateToStr(newNextRunAt),
        expected: dateToStr(expectedNextRunAt),
        now: new Date().toISOString(),
      });
    return result.changes > 0;
  }

  generateId(): string {
    return randomUUID();
  }

  async ping(): Promise<boolean> {
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
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
    nextRunAt: strToDate(row.next_run_at)!,
    lastRunAt: strToDate(row.last_run_at),
    lastRunStatus: (row.last_run_status as string | null) ?? undefined,
    lastRunId: (row.last_run_id as string | null) ?? undefined,
    createdAt: strToDate(row.created_at)!,
    updatedAt: strToDate(row.updated_at)!,
    createdBy: (row.created_by as string | null) ?? undefined,
  };
}
