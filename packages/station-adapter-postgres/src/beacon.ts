import { randomUUID } from "node:crypto";
import pg from "pg";
import type {
  BeaconStateAdapter,
  BeaconInstance,
  BeaconInstancePatch,
  BeaconEvent,
} from "station-beacon";
import { validateTableName } from "./shared.js";

export interface BeaconPostgresAdapterOptions {
  connectionString?: string;
  pool?: pg.Pool;
  tableName?: string;
  eventsTableName?: string;
}

/** Durable {@link BeaconStateAdapter} backed by PostgreSQL (pg). */
export class BeaconPostgresAdapter implements BeaconStateAdapter {
  private pool: pg.Pool;
  private ownsPool: boolean;
  private table: string;
  private eventsTable: string;
  private initialized: Promise<void>;

  constructor(options: BeaconPostgresAdapterOptions = {}) {
    this.table = validateTableName(options.tableName ?? "beacon_instances");
    this.eventsTable = validateTableName(options.eventsTableName ?? "beacon_events");
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
        beacon_name        TEXT PRIMARY KEY,
        status             TEXT NOT NULL,
        desired_state      TEXT NOT NULL,
        incarnation        INTEGER NOT NULL DEFAULT 0,
        restart_count      INTEGER NOT NULL DEFAULT 0,
        pid                INTEGER,
        config             TEXT,
        started_at         TIMESTAMPTZ,
        ready_at           TIMESTAMPTZ,
        last_heartbeat_at  TIMESTAMPTZ,
        last_exit_at       TIMESTAMPTZ,
        last_exit_reason   TEXT,
        last_error         TEXT,
        next_restart_at    TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL,
        updated_at         TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
        seq         BIGSERIAL PRIMARY KEY,
        id          TEXT NOT NULL,
        beacon_name TEXT NOT NULL,
        incarnation INTEGER NOT NULL,
        type        TEXT NOT NULL,
        message     TEXT,
        at          TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_beacon
        ON ${this.eventsTable} (beacon_name, seq)
    `);
  }

  private async ready(): Promise<void> {
    await this.initialized;
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.table}
        (beacon_name, status, desired_state, incarnation, restart_count, pid, config,
         started_at, ready_at, last_heartbeat_at, last_exit_at, last_exit_reason,
         last_error, next_restart_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (beacon_name) DO UPDATE SET
         status = EXCLUDED.status,
         desired_state = EXCLUDED.desired_state,
         incarnation = EXCLUDED.incarnation,
         restart_count = EXCLUDED.restart_count,
         pid = EXCLUDED.pid,
         config = EXCLUDED.config,
         started_at = EXCLUDED.started_at,
         ready_at = EXCLUDED.ready_at,
         last_heartbeat_at = EXCLUDED.last_heartbeat_at,
         last_exit_at = EXCLUDED.last_exit_at,
         last_exit_reason = EXCLUDED.last_exit_reason,
         last_error = EXCLUDED.last_error,
         next_restart_at = EXCLUDED.next_restart_at,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at`,
      [
        instance.beaconName,
        instance.status,
        instance.desiredState,
        instance.incarnation,
        instance.restartCount,
        instance.pid ?? null,
        instance.config ?? null,
        instance.startedAt ?? null,
        instance.readyAt ?? null,
        instance.lastHeartbeatAt ?? null,
        instance.lastExitAt ?? null,
        instance.lastExitReason ?? null,
        instance.lastError ?? null,
        instance.nextRestartAt ?? null,
        instance.createdAt,
        instance.updatedAt,
      ],
    );
  }

  async getInstance(beaconName: string): Promise<BeaconInstance | null> {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM ${this.table} WHERE beacon_name = $1`, [beaconName]);
    return result.rows.length > 0 ? rowToInstance(result.rows[0]) : null;
  }

  async updateInstance(beaconName: string, patch: BeaconInstancePatch): Promise<void> {
    await this.ready();
    const map: Record<string, string> = {
      status: "status",
      desiredState: "desired_state",
      incarnation: "incarnation",
      restartCount: "restart_count",
      pid: "pid",
      config: "config",
      startedAt: "started_at",
      readyAt: "ready_at",
      lastHeartbeatAt: "last_heartbeat_at",
      lastExitAt: "last_exit_at",
      lastExitReason: "last_exit_reason",
      lastError: "last_error",
      nextRestartAt: "next_restart_at",
      updatedAt: "updated_at",
    };
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      const col = map[key];
      if (!col) continue;
      touched = true;
      setClauses.push(`${col} = $${i++}`);
      values.push(value === undefined ? null : value);
    }
    if (touched && !("updatedAt" in patch)) {
      setClauses.push(`updated_at = $${i++}`);
      values.push(new Date());
    }
    if (setClauses.length === 0) return;
    values.push(beaconName);
    await this.pool.query(
      `UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE beacon_name = $${i}`,
      values,
    );
  }

  async listInstances(): Promise<BeaconInstance[]> {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM ${this.table} ORDER BY beacon_name ASC`);
    return result.rows.map(rowToInstance);
  }

  async removeInstance(beaconName: string): Promise<void> {
    await this.ready();
    await this.pool.query(`DELETE FROM ${this.table} WHERE beacon_name = $1`, [beaconName]);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    await this.ready();
    await this.pool.query(
      `INSERT INTO ${this.eventsTable} (id, beacon_name, incarnation, type, message, at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.id, event.beaconName, event.incarnation, event.type, event.message ?? null, event.at],
    );
  }

  async listEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    await this.ready();
    const result = await this.pool.query(
      `SELECT * FROM ${this.eventsTable} WHERE beacon_name = $1 ORDER BY seq DESC LIMIT $2`,
      [beaconName, limit],
    );
    return result.rows.map(rowToEvent);
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

function rowToInstance(row: Record<string, unknown>): BeaconInstance {
  return {
    beaconName: row.beacon_name as string,
    status: row.status as BeaconInstance["status"],
    desiredState: row.desired_state as BeaconInstance["desiredState"],
    incarnation: Number(row.incarnation),
    restartCount: Number(row.restart_count),
    pid: row.pid != null ? Number(row.pid) : undefined,
    config: (row.config as string | null) ?? undefined,
    startedAt: (row.started_at as Date | null) ?? undefined,
    readyAt: (row.ready_at as Date | null) ?? undefined,
    lastHeartbeatAt: (row.last_heartbeat_at as Date | null) ?? undefined,
    lastExitAt: (row.last_exit_at as Date | null) ?? undefined,
    lastExitReason: (row.last_exit_reason as BeaconInstance["lastExitReason"] | null) ?? undefined,
    lastError: (row.last_error as string | null) ?? undefined,
    nextRestartAt: (row.next_restart_at as Date | null) ?? undefined,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function rowToEvent(row: Record<string, unknown>): BeaconEvent {
  return {
    id: row.id as string,
    beaconName: row.beacon_name as string,
    incarnation: Number(row.incarnation),
    type: row.type as BeaconEvent["type"],
    message: (row.message as string | null) ?? undefined,
    at: row.at as Date,
  };
}
