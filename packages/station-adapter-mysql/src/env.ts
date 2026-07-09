import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  EnvVar,
  EnvVarPatch,
  EnvStorageAdapter,
  EnvTarget,
} from "station-env";
import { validateTableName, dateToStr, toDate } from "./shared.js";

export interface EnvMysqlAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  tableName?: string;
}

/**
 * Durable {@link EnvStorageAdapter} backed by MySQL. Constructed via the async
 * static `create()` factory (the constructor is private) so schema setup can be
 * awaited before the adapter is used.
 */
export class EnvMysqlAdapter implements EnvStorageAdapter {
  private pool: Pool;
  private table: string;
  private ownsPool: boolean;

  private constructor(pool: Pool, table: string, ownsPool: boolean) {
    this.pool = pool;
    this.table = table;
    this.ownsPool = ownsPool;
  }

  static async create(options: EnvMysqlAdapterOptions = {}): Promise<EnvMysqlAdapter> {
    const table = validateTableName(options.tableName ?? "env_vars");
    let pool: Pool;
    let ownsPool: boolean;
    if (options.pool) {
      pool = options.pool;
      ownsPool = false;
    } else {
      if (!options.connectionString) {
        throw new Error("EnvMysqlAdapter requires a connectionString or an existing pool.");
      }
      pool = mysql.createPool(options.connectionString);
      ownsPool = true;
    }

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${table} (
        id          VARCHAR(36) PRIMARY KEY,
        \`key\`     VARCHAR(256) NOT NULL,
        value       TEXT NOT NULL,
        secret      TINYINT NOT NULL DEFAULT 0,
        targets     TEXT NOT NULL,
        created_at  DATETIME(3) NOT NULL,
        updated_at  DATETIME(3) NOT NULL,
        created_by  VARCHAR(255),
        INDEX idx_${table}_key (\`key\`)
      )
    `);

    return new EnvMysqlAdapter(pool, table, ownsPool);
  }

  async add(envVar: EnvVar): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.table}
        (id, \`key\`, value, secret, targets, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        envVar.id,
        envVar.key,
        envVar.value,
        envVar.secret ? 1 : 0,
        JSON.stringify(envVar.targets ?? []),
        dateToStr(envVar.createdAt),
        dateToStr(envVar.updatedAt),
        envVar.createdBy ?? null,
      ],
    );
  }

  async get(id: string): Promise<EnvVar | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} WHERE id = ?`,
      [id],
    );
    return rows.length > 0 ? rowToEnvVar(rows[0] as Record<string, unknown>) : null;
  }

  async list(): Promise<EnvVar[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} ORDER BY \`key\` ASC, created_at ASC`,
    );
    return rows.map((r) => rowToEnvVar(r as Record<string, unknown>));
  }

  async update(id: string, patch: EnvVarPatch): Promise<void> {
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];
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
      setClauses.push(`${col} = ?`);
      if (value === undefined) values.push(null);
      else if (key === "secret") values.push(value ? 1 : 0);
      else if (key === "targets") values.push(JSON.stringify(value));
      else if (key === "updatedAt") values.push(dateToStr(value));
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

function rowToEnvVar(row: Record<string, unknown>): EnvVar {
  return {
    id: row.id as string,
    key: row.key as string,
    value: row.value as string,
    secret: Boolean(row.secret),
    targets: parseTargets(row.targets),
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
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
