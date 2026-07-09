import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  EnvVar,
  EnvVarPatch,
  EnvStorageAdapter,
  EnvTarget,
} from "station-env";
import { validateTableName } from "./shared.js";

export interface EnvPostgresAdapterOptions {
  connectionString?: string;
  pool?: pg.Pool;
  tableName?: string;
}

/** Durable {@link EnvStorageAdapter} backed by PostgreSQL. */
export class EnvPostgresAdapter implements EnvStorageAdapter {
  private pool: pg.Pool;
  private ownsPool: boolean;
  private table: string;
  private initialized: Promise<void>;

  constructor(options: EnvPostgresAdapterOptions = {}) {
    this.table = validateTableName(options.tableName ?? "env_vars");
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
        id          TEXT PRIMARY KEY,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        secret      BOOLEAN NOT NULL DEFAULT FALSE,
        targets     TEXT NOT NULL DEFAULT '[]',
        created_at  TIMESTAMPTZ NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL,
        created_by  TEXT
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_key ON ${this.table} (key)
    `);
  }

  private async ready(): Promise<void> {
    await this.initialized;
  }

  async add(envVar: EnvVar): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.table}
        (id, key, value, secret, targets, created_at, updated_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        envVar.id,
        envVar.key,
        envVar.value,
        envVar.secret,
        JSON.stringify(envVar.targets ?? []),
        envVar.createdAt,
        envVar.updatedAt,
        envVar.createdBy ?? null,
      ],
    );
  }

  async get(id: string): Promise<EnvVar | null> {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return result.rows.length > 0 ? rowToEnvVar(result.rows[0]) : null;
  }

  async list(): Promise<EnvVar[]> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} ORDER BY key ASC, created_at ASC`,
    );
    return result.rows.map(rowToEnvVar);
  }

  async update(id: string, patch: EnvVarPatch): Promise<void> {
    await this.ready();
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
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
      // Treat an explicit `undefined` as "leave unchanged" — EnvStore.update
      // sends every field, so writing NULL here would violate the NOT NULL
      // secret/targets columns and clobber a value-only edit.
      if (value === undefined) continue;
      touched = true;
      setClauses.push(`${col} = $${i++}`);
      if (key === "targets") values.push(JSON.stringify(value));
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

function rowToEnvVar(row: Record<string, unknown>): EnvVar {
  return {
    id: row.id as string,
    key: row.key as string,
    value: row.value as string,
    secret: Boolean(row.secret),
    targets: parseTargets(row.targets),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
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
