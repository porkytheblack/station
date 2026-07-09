import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  EnvVar,
  EnvVarPatch,
  EnvStorageAdapter,
  EnvTarget,
} from "station-env";
import { validateTableName, dateToStr, strToDate } from "./shared.js";

export interface EnvSqliteAdapterOptions {
  dbPath?: string;
  tableName?: string;
}

/** Durable {@link EnvStorageAdapter} backed by SQLite (better-sqlite3). */
export class EnvSqliteAdapter implements EnvStorageAdapter {
  private db: Database.Database;
  private table: string;
  private stmtCache = new Map<string, Database.Statement>();

  private prep(sql: string): Database.Statement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  constructor(options: EnvSqliteAdapterOptions = {}) {
    const dbPath = options.dbPath ?? "station.db";
    this.table = validateTableName(options.tableName ?? "env_vars");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id          TEXT PRIMARY KEY,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        secret      INTEGER NOT NULL DEFAULT 0,
        targets     TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        created_by  TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_key ON ${this.table} (key)
    `);
  }

  async add(envVar: EnvVar): Promise<void> {
    this.prep(`
      INSERT INTO ${this.table}
        (id, key, value, secret, targets, created_at, updated_at, created_by)
      VALUES
        (@id, @key, @value, @secret, @targets, @created_at, @updated_at, @created_by)
    `).run({
      id: envVar.id,
      key: envVar.key,
      value: envVar.value,
      secret: envVar.secret ? 1 : 0,
      targets: JSON.stringify(envVar.targets ?? []),
      created_at: dateToStr(envVar.createdAt),
      updated_at: dateToStr(envVar.updatedAt),
      created_by: envVar.createdBy ?? null,
    });
  }

  async get(id: string): Promise<EnvVar | null> {
    const row = this.prep(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEnvVar(row) : null;
  }

  async list(): Promise<EnvVar[]> {
    const rows = this.prep(`SELECT * FROM ${this.table} ORDER BY key ASC, created_at ASC`).all() as Record<string, unknown>[];
    return rows.map(rowToEnvVar);
  }

  async update(id: string, patch: EnvVarPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id };
    const map: Record<string, string> = {
      value: "value",
      secret: "secret",
      targets: "targets",
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
      } else if (key === "secret") {
        values[param] = value ? 1 : 0;
      } else if (key === "targets") {
        values[param] = JSON.stringify(value);
      } else if (key === "updatedAt") {
        values[param] = dateToStr(value);
      } else {
        values[param] = value;
      }
    }

    if (touched && !("updatedAt" in patch)) {
      setClauses.push("updated_at = @p_updated_at");
      values.p_updated_at = new Date().toISOString();
    }
    if (setClauses.length === 0) return;
    this.prep(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE id = @id`).run(values);
  }

  async delete(id: string): Promise<boolean> {
    const result = this.prep(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
    return result.changes > 0;
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

function rowToEnvVar(row: Record<string, unknown>): EnvVar {
  return {
    id: row.id as string,
    key: row.key as string,
    value: row.value as string,
    secret: Boolean(row.secret),
    targets: parseTargets(row.targets),
    createdAt: strToDate(row.created_at)!,
    updatedAt: strToDate(row.updated_at)!,
    createdBy: (row.created_by as string | null) ?? undefined,
  };
}

function parseTargets(raw: unknown): EnvTarget[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
