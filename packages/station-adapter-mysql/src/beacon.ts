import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { Pool, RowDataPacket } from "mysql2/promise";
import type {
  BeaconStateAdapter,
  BeaconInstance,
  BeaconInstanceFilter,
  BeaconInstancePatch,
  BeaconEvent,
} from "station-beacon";
import { validateTableName, dateToStr, toDate, runIdempotentDdl } from "./shared.js";

export interface BeaconMysqlAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  tableName?: string;
  eventsTableName?: string;
  /** Max lifecycle events retained per instance. @default 1000 */
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
        id                 VARCHAR(191) PRIMARY KEY,
        beacon_name        VARCHAR(255) NOT NULL,
        label              TEXT,
        origin             VARCHAR(20) NOT NULL DEFAULT 'definition',
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
        ,station_id        VARCHAR(255)
        ,exposure          TEXT
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS ${eventsTable} (
        seq         BIGINT AUTO_INCREMENT PRIMARY KEY,
        id          VARCHAR(36) NOT NULL,
        instance_id VARCHAR(191) NOT NULL,
        beacon_name VARCHAR(255) NOT NULL,
        incarnation INT NOT NULL,
        type        VARCHAR(50) NOT NULL,
        message     TEXT,
        at          DATETIME(3) NOT NULL
      )
    `);
    await migrateToMultiInstance(pool, table, eventsTable);
    await runIdempotentDdl((sql) => pool.execute(sql), `ALTER TABLE ${table} ADD COLUMN station_id VARCHAR(255)`);
    await runIdempotentDdl((sql) => pool.execute(sql), `ALTER TABLE ${table} ADD COLUMN exposure TEXT`);

    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${eventsTable}_instance ON ${eventsTable} (instance_id, seq)`,
    );
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${eventsTable}_beacon ON ${eventsTable} (beacon_name, seq)`,
    );
    await runIdempotentDdl(
      (sql) => pool.execute(sql),
      `CREATE INDEX idx_${table}_beacon ON ${table} (beacon_name)`,
    );

    return new BeaconMysqlAdapter(pool, table, eventsTable, ownsPool, maxEvents);
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.table}
        (id, beacon_name, label, origin, status, desired_state, incarnation, restart_count, pid, config,
         started_at, ready_at, last_heartbeat_at, last_exit_at, last_exit_reason,
         last_error, next_restart_at, created_at, updated_at, station_id, exposure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         beacon_name = VALUES(beacon_name),
         label = VALUES(label),
         origin = VALUES(origin),
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
         updated_at = VALUES(updated_at),
         station_id = VALUES(station_id),
         exposure = VALUES(exposure)`,
      [
        instance.id,
        instance.beaconName,
        instance.label ?? null,
        instance.origin,
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
        instance.stationId ?? null,
        instance.exposure ?? null,
      ],
    );
  }

  async getInstance(instanceId: string): Promise<BeaconInstance | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.table} WHERE id = ?`,
      [instanceId],
    );
    return rows.length > 0 ? rowToInstance(rows[0] as Record<string, unknown>) : null;
  }

  async updateInstance(instanceId: string, patch: BeaconInstancePatch): Promise<void> {
    const map: Record<string, { col: string; date?: boolean }> = {
      label: { col: "label" },
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
      stationId: { col: "station_id" },
      exposure: { col: "exposure" },
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
    values.push(instanceId);
    await this.pool.execute(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE id = ?`, values);
  }

  async listInstances(filter?: BeaconInstanceFilter): Promise<BeaconInstance[]> {
    const [rows] = filter?.beaconName
      ? await this.pool.execute<RowDataPacket[]>(
          `SELECT * FROM ${this.table} WHERE beacon_name = ? ORDER BY id ASC`,
          [filter.beaconName],
        )
      : await this.pool.execute<RowDataPacket[]>(`SELECT * FROM ${this.table} ORDER BY id ASC`);
    return rows.map((r) => rowToInstance(r as Record<string, unknown>));
  }

  async removeInstance(instanceId: string): Promise<void> {
    await this.pool.execute(`DELETE FROM ${this.table} WHERE id = ?`, [instanceId]);
    await this.pool.execute(`DELETE FROM ${this.eventsTable} WHERE instance_id = ?`, [instanceId]);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.eventsTable} (id, instance_id, beacon_name, incarnation, type, message, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.instanceId,
        event.beaconName,
        event.incarnation,
        event.type,
        event.message ?? null,
        dateToStr(event.at),
      ],
    );
    // Prune this instance's oldest events beyond the retention cap. The inner
    // query finds the seq of the maxEvents-th newest row; rows at/below it are
    // deleted. OFFSET is inlined (coerced integer) as mysql2 doesn't reliably
    // bind LIMIT/OFFSET placeholders, and the subquery is wrapped in a derived
    // table so MySQL allows referencing the DELETE target. When the instance has
    // <= maxEvents rows the inner query yields no row → NULL → nothing deleted.
    const cap = Math.max(0, Math.floor(this.maxEvents));
    await this.pool.execute(
      `DELETE FROM ${this.eventsTable}
       WHERE instance_id = ?
         AND seq <= (
           SELECT s FROM (
             SELECT seq AS s FROM ${this.eventsTable}
             WHERE instance_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ${cap}
           ) AS cutoff
         )`,
      [event.instanceId, event.instanceId],
    );
  }

  async listEvents(instanceId: string, limit = 100): Promise<BeaconEvent[]> {
    // LIMIT is inlined (coerced integer) — mysql2 prepared statements don't
    // reliably bind LIMIT placeholders.
    const lim = Math.max(1, Math.floor(limit));
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM ${this.eventsTable} WHERE instance_id = ? ORDER BY seq DESC LIMIT ${lim}`,
      [instanceId],
    );
    return rows.map((r) => rowToEvent(r as Record<string, unknown>));
  }

  async listBeaconEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
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

/**
 * Bring a pre-multi-instance database forward. The old layout keyed instances by
 * `beacon_name`; the new one keys them by instance id, and a beacon's
 * definition-owned instance uses the beacon name as its id — so the migration is
 * a column rename (CHANGE COLUMN keeps the primary key) plus a backfill, and
 * every existing row keeps its identity, desired state, and counters.
 */
async function migrateToMultiInstance(
  pool: Pool,
  table: string,
  eventsTable: string,
): Promise<void> {
  const hasColumn = async (t: string, column: string): Promise<boolean> => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [t, column],
    );
    return rows.length > 0;
  };

  if (!(await hasColumn(table, "id"))) {
    await pool.execute(
      `ALTER TABLE ${table} CHANGE COLUMN beacon_name id VARCHAR(191) NOT NULL`,
    );
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN beacon_name VARCHAR(255) NULL`);
    await pool.execute(`UPDATE ${table} SET beacon_name = id WHERE beacon_name IS NULL`);
  }
  if (!(await hasColumn(table, "label"))) {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN label TEXT`);
  }
  if (!(await hasColumn(table, "origin"))) {
    await pool.execute(
      `ALTER TABLE ${table} ADD COLUMN origin VARCHAR(20) NOT NULL DEFAULT 'definition'`,
    );
  }
  if (!(await hasColumn(eventsTable, "instance_id"))) {
    await pool.execute(`ALTER TABLE ${eventsTable} ADD COLUMN instance_id VARCHAR(191) NULL`);
    await pool.execute(
      `UPDATE ${eventsTable} SET instance_id = beacon_name WHERE instance_id IS NULL`,
    );
  }
}

function rowToInstance(row: Record<string, unknown>): BeaconInstance {
  return {
    id: row.id as string,
    beaconName: (row.beacon_name as string | null) ?? (row.id as string),
    label: (row.label as string | null) ?? undefined,
    origin: ((row.origin as string | null) ?? "definition") as BeaconInstance["origin"],
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
    stationId: (row.station_id as string | null) ?? undefined,
    exposure: (row.exposure as string | null) ?? undefined,
    createdAt: toDate(row.created_at)!,
    updatedAt: toDate(row.updated_at)!,
  };
}

function rowToEvent(row: Record<string, unknown>): BeaconEvent {
  return {
    id: row.id as string,
    instanceId: ((row.instance_id as string | null) ?? (row.beacon_name as string)) ?? "",
    beaconName: row.beacon_name as string,
    incarnation: Number(row.incarnation),
    type: row.type as BeaconEvent["type"],
    message: (row.message as string | null) ?? undefined,
    at: toDate(row.at)!,
  };
}
