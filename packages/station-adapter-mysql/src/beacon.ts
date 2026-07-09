import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type {
  BeaconStateAdapter,
  BeaconInstance,
  BeaconInstancePatch,
  BeaconEvent,
} from "station-beacon";
import { validateTableName, dateToStr, toDate, runIdempotentDdl } from "./shared.js";

export interface BeaconMysqlAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  tableName?: string;
  eventsTableName?: string;
  /** Max lifecycle events retained per beacon. @default 1000 */
  maxEventsPerBeacon?: number;
}

/** Durable {@link BeaconStateAdapter} backed by MySQL (mysql2). */
export class BeaconMysqlAdapter implements BeaconStateAdapter {
  private pool: Pool;
  private table: string;
  private eventsTable: string;
  private ownsPool: boolean;
  private maxEvents: number;

  private constructor(pool: Pool, table: string, eventsTable: string, ownsPool: boolean, maxEvents: number) {
    this.pool = pool;
    this.table = table;
    this.eventsTable = eventsTable;
    this.ownsPool = ownsPool;
    this.maxEvents = maxEvents;
  }

  static async create(options: BeaconMysqlAdapterOptions = {}): Promise<BeaconMysqlAdapter> {
    const table = validateTableName(options.tableName ?? "beacon_instances");
    const eventsTable = validateTableName(options.eventsTableName ?? "beacon_events");
    const maxEvents = options.maxEventsPerBeacon ?? 1000;
    let pool: Pool;
    let ownsPool: boolean;
    if (options.pool) {
      pool = options.pool;
      ownsPool = false;
    } else {
      if (!options.connectionString) {
        throw new Error("BeaconMysqlAdapter requires a connectionString or an existing pool.");
      }
      pool = mysql.createPool(options.connectionString);
      ownsPool = true;
    }

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${table} (
        beacon_name        VARCHAR(255) PRIMARY KEY,
        status             VARCHAR(50) NOT NULL,
        desired_state      VARCHAR(50) NOT NULL,
        incarnation        INT NOT NULL DEFAULT 0,
        restart_count      INT NOT NULL DEFAULT 0,
        pid                INT,
        config             TEXT,
        started_at         DATETIME(3),
        ready_at           DATETIME(3),
        last_heartbeat_at  DATETIME(3),
        last_exit_at       DATETIME(3),
        last_exit_reason   VARCHAR(50),
        last_error         TEXT,
        next_restart_at    DATETIME(3),
        created_at         DATETIME(3) NOT NULL,
        updated_at         DATETIME(3) NOT NULL
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${eventsTable} (
        seq         BIGINT AUTO_INCREMENT PRIMARY KEY,
        id          VARCHAR(36) NOT NULL,
        beacon_name VARCHAR(255) NOT NULL,
        incarnation INT NOT NULL,
        type        VARCHAR(50) NOT NULL,
        message     TEXT,
        at          DATETIME(3) NOT NULL
      )
    `);
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${eventsTable}_beacon ON ${eventsTable} (beacon_name, seq)`,
    );

    return new BeaconMysqlAdapter(pool, table, eventsTable, ownsPool, maxEvents);
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.table}
        (beacon_name, status, desired_state, incarnation, restart_count, pid, config,
         started_at, ready_at, last_heartbeat_at, last_exit_at, last_exit_reason,
         last_error, next_restart_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         desired_state = VALUES(desired_state),
         incarnation = VALUES(incarnation),
         restart_count = VALUES(restart_count),
         pid = VALUES(pid),
         config = VALUES(config),
         started_at = VALUES(started_at),
         ready_at = VALUES(ready_at),
         last_heartbeat_at = VALUES(last_heartbeat_at),
         last_exit_at = VALUES(last_exit_at),
         last_exit_reason = VALUES(last_exit_reason),
         last_error = VALUES(last_error),
         next_restart_at = VALUES(next_restart_at),
         created_at = VALUES(created_at),
         updated_at = VALUES(updated_at)`,
      [
        instance.beaconName,
        instance.status,
        instance.desiredState,
        instance.incarnation,
        instance.restartCount,
        instance.pid ?? null,
        instance.config ?? null,
        dateToStr(instance.startedAt),
        dateToStr(instance.readyAt),
        dateToStr(instance.lastHeartbeatAt),
        dateToStr(instance.lastExitAt),
        instance.lastExitReason ?? null,
        instance.lastError ?? null,
        dateToStr(instance.nextRestartAt),
        dateToStr(instance.createdAt),
        dateToStr(instance.updatedAt),
      ],
    );
  }

  async getInstance(beaconName: string): Promise<BeaconInstance | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} WHERE beacon_name = ?`,
      [beaconName],
    );
    return rows.length > 0 ? rowToInstance(rows[0] as Record<string, unknown>) : null;
  }

  async updateInstance(beaconName: string, patch: BeaconInstancePatch): Promise<void> {
    const map: Record<string, { col: string; date?: boolean }> = {
      status: { col: "status" },
      desiredState: { col: "desired_state" },
      incarnation: { col: "incarnation" },
      restartCount: { col: "restart_count" },
      pid: { col: "pid" },
      config: { col: "config" },
      startedAt: { col: "started_at", date: true },
      readyAt: { col: "ready_at", date: true },
      lastHeartbeatAt: { col: "last_heartbeat_at", date: true },
      lastExitAt: { col: "last_exit_at", date: true },
      lastExitReason: { col: "last_exit_reason" },
      lastError: { col: "last_error" },
      nextRestartAt: { col: "next_restart_at", date: true },
      updatedAt: { col: "updated_at", date: true },
    };
    const setClauses: string[] = [];
    const values: (string | number | null)[] = [];
    let touched = false;
    for (const [key, value] of Object.entries(patch)) {
      const entry = map[key];
      if (!entry) continue;
      touched = true;
      setClauses.push(`${entry.col} = ?`);
      if (value === undefined) values.push(null);
      else if (entry.date) values.push(dateToStr(value));
      else values.push(value as string | number);
    }
    if (touched && !("updatedAt" in patch)) {
      setClauses.push("updated_at = ?");
      values.push(dateToStr(new Date()));
    }
    if (setClauses.length === 0) return;
    values.push(beaconName);
    await this.pool.execute(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE beacon_name = ?`, values);
  }

  async listInstances(): Promise<BeaconInstance[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} ORDER BY beacon_name ASC`,
    );
    return rows.map((r) => rowToInstance(r as Record<string, unknown>));
  }

  async removeInstance(beaconName: string): Promise<void> {
    await this.pool.execute(`DELETE FROM ${this.table} WHERE beacon_name = ?`, [beaconName]);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.eventsTable} (id, beacon_name, incarnation, type, message, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [event.id, event.beaconName, event.incarnation, event.type, event.message ?? null, dateToStr(event.at)],
    );
    // Prune this beacon's oldest events beyond the retention cap. The inner
    // query finds the seq of the maxEvents-th newest row; rows at/below it are
    // deleted. OFFSET is inlined (coerced integer) as mysql2 doesn't reliably
    // bind LIMIT/OFFSET placeholders, and the subquery is wrapped in a derived
    // table so MySQL allows referencing the DELETE target. When the beacon has
    // <= maxEvents rows the inner query yields no row → NULL → nothing deleted.
    const cap = Math.max(0, Math.floor(this.maxEvents));
    await this.pool.execute(
      `DELETE FROM ${this.eventsTable}
       WHERE beacon_name = ?
         AND seq <= (
           SELECT s FROM (
             SELECT seq AS s FROM ${this.eventsTable}
             WHERE beacon_name = ? ORDER BY seq DESC LIMIT 1 OFFSET ${cap}
           ) AS cutoff
         )`,
      [event.beaconName, event.beaconName],
    );
  }

  async listEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    // LIMIT is inlined (coerced integer) — mysql2 prepared statements don't
    // reliably bind LIMIT placeholders.
    const lim = Math.max(1, Math.floor(limit));
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.eventsTable} WHERE beacon_name = ? ORDER BY seq DESC LIMIT ${lim}`,
      [beaconName],
    );
    return rows.map((r) => rowToEvent(r as Record<string, unknown>));
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

function rowToInstance(row: Record<string, unknown>): BeaconInstance {
  return {
    beaconName: row.beacon_name as string,
    status: row.status as BeaconInstance["status"],
    desiredState: row.desired_state as BeaconInstance["desiredState"],
    incarnation: Number(row.incarnation),
    restartCount: Number(row.restart_count),
    pid: row.pid != null ? Number(row.pid) : undefined,
    config: (row.config as string | null) ?? undefined,
    startedAt: toDate(row.started_at),
    readyAt: toDate(row.ready_at),
    lastHeartbeatAt: toDate(row.last_heartbeat_at),
    lastExitAt: toDate(row.last_exit_at),
    lastExitReason: (row.last_exit_reason as BeaconInstance["lastExitReason"] | null) ?? undefined,
    lastError: (row.last_error as string | null) ?? undefined,
    nextRestartAt: toDate(row.next_restart_at),
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
  };
}

function rowToEvent(row: Record<string, unknown>): BeaconEvent {
  return {
    id: row.id as string,
    beaconName: row.beacon_name as string,
    incarnation: Number(row.incarnation),
    type: row.type as BeaconEvent["type"],
    message: (row.message as string | null) ?? undefined,
    at: toDate(row.at)!,
  };
}
