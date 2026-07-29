import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  BeaconStateAdapter,
  BeaconInstance,
  BeaconInstanceFilter,
  BeaconInstancePatch,
  BeaconEvent,
} from "station-beacon";
import { validateTableName, dateToStr, strToDate } from "./shared.js";

export interface BeaconSqliteAdapterOptions {
  dbPath?: string;
  /** Table name for instance records. @default "beacon_instances" */
  tableName?: string;
  /** Table name for the lifecycle event log. @default "beacon_events" */
  eventsTableName?: string;
  /** Max lifecycle events retained per instance. @default 1000 */
  maxEventsPerBeacon?: number;
}

/** Durable {@link BeaconStateAdapter} backed by SQLite (better-sqlite3). */
export class BeaconSqliteAdapter implements BeaconStateAdapter {
  private db: Database.Database;
  private table: string;
  private eventsTable: string;
  private maxEvents: number;
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

  constructor(options: BeaconSqliteAdapterOptions = {}) {
    const dbPath = options.dbPath ?? "station.db";
    this.table = validateTableName(options.tableName ?? "beacon_instances");
    this.eventsTable = validateTableName(options.eventsTableName ?? "beacon_events");
    this.maxEvents = options.maxEventsPerBeacon ?? 1000;
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        id                 TEXT PRIMARY KEY,
        beacon_name        TEXT NOT NULL,
        label              TEXT,
        origin             TEXT NOT NULL DEFAULT 'definition',
        status             TEXT NOT NULL,
        desired_state      TEXT NOT NULL,
        incarnation        INTEGER NOT NULL DEFAULT 0,
        restart_count      INTEGER NOT NULL DEFAULT 0,
        pid                INTEGER,
        config             TEXT,
        started_at         TEXT,
        ready_at           TEXT,
        last_heartbeat_at  TEXT,
        last_exit_at       TEXT,
        last_exit_reason   TEXT,
        last_error         TEXT,
        next_restart_at    TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.eventsTable} (
        id          TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        beacon_name TEXT NOT NULL,
        incarnation INTEGER NOT NULL,
        type        TEXT NOT NULL,
        message     TEXT,
        at          TEXT NOT NULL,
        seq         INTEGER
      )
    `);

    this.migrateToMultiInstance();

    // Monotonic sequence so events list newest-first even when the `at`
    // timestamps collide (same-millisecond bursts).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_instance
        ON ${this.eventsTable} (instance_id, seq)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_beacon
        ON ${this.eventsTable} (beacon_name, seq)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.table}_beacon
        ON ${this.table} (beacon_name)
    `);
  }

  private columns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  }

  /**
   * Bring a pre-multi-instance database forward. The old layout keyed instances
   * by `beacon_name`; the new one keys them by instance id, and a beacon's
   * definition-owned instance uses the beacon name as its id — so the migration
   * is a rename plus a backfill, and every existing row keeps its identity,
   * desired state, and restart counters.
   */
  private migrateToMultiInstance(): void {
    if (!this.columns(this.table).has("id")) {
      // The old primary key column becomes the instance id, so the row keeps
      // its identity (and the PK constraint follows the rename).
      this.db.exec(`ALTER TABLE ${this.table} RENAME COLUMN beacon_name TO id`);
      this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN beacon_name TEXT`);
      this.db.exec(`UPDATE ${this.table} SET beacon_name = id WHERE beacon_name IS NULL`);
    }
    if (!this.columns(this.table).has("label")) {
      this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN label TEXT`);
    }
    if (!this.columns(this.table).has("origin")) {
      this.db.exec(
        `ALTER TABLE ${this.table} ADD COLUMN origin TEXT NOT NULL DEFAULT 'definition'`,
      );
    }

    if (!this.columns(this.eventsTable).has("instance_id")) {
      this.db.exec(`ALTER TABLE ${this.eventsTable} ADD COLUMN instance_id TEXT`);
      this.db.exec(
        `UPDATE ${this.eventsTable} SET instance_id = beacon_name WHERE instance_id IS NULL`,
      );
    }
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    this.prep(`
      INSERT OR REPLACE INTO ${this.table}
        (id, beacon_name, label, origin, status, desired_state, incarnation, restart_count, pid, config,
         started_at, ready_at, last_heartbeat_at, last_exit_at, last_exit_reason,
         last_error, next_restart_at, created_at, updated_at)
      VALUES
        (@id, @beacon_name, @label, @origin, @status, @desired_state, @incarnation, @restart_count, @pid, @config,
         @started_at, @ready_at, @last_heartbeat_at, @last_exit_at, @last_exit_reason,
         @last_error, @next_restart_at, @created_at, @updated_at)
    `).run({
      id: instance.id,
      beacon_name: instance.beaconName,
      label: instance.label ?? null,
      origin: instance.origin,
      status: instance.status,
      desired_state: instance.desiredState,
      incarnation: instance.incarnation,
      restart_count: instance.restartCount,
      pid: instance.pid ?? null,
      config: instance.config ?? null,
      started_at: dateToStr(instance.startedAt),
      ready_at: dateToStr(instance.readyAt),
      last_heartbeat_at: dateToStr(instance.lastHeartbeatAt),
      last_exit_at: dateToStr(instance.lastExitAt),
      last_exit_reason: instance.lastExitReason ?? null,
      last_error: instance.lastError ?? null,
      next_restart_at: dateToStr(instance.nextRestartAt),
      created_at: dateToStr(instance.createdAt),
      updated_at: dateToStr(instance.updatedAt),
    });
  }

  async getInstance(instanceId: string): Promise<BeaconInstance | null> {
    const row = this.prep(`SELECT * FROM ${this.table} WHERE id = ?`).get(instanceId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToInstance(row) : null;
  }

  async updateInstance(instanceId: string, patch: BeaconInstancePatch): Promise<void> {
    const map: Record<string, { col: string; kind: "str" | "num" | "date" }> = {
      label: { col: "label", kind: "str" },
      status: { col: "status", kind: "str" },
      desiredState: { col: "desired_state", kind: "str" },
      incarnation: { col: "incarnation", kind: "num" },
      restartCount: { col: "restart_count", kind: "num" },
      pid: { col: "pid", kind: "num" },
      config: { col: "config", kind: "str" },
      startedAt: { col: "started_at", kind: "date" },
      readyAt: { col: "ready_at", kind: "date" },
      lastHeartbeatAt: { col: "last_heartbeat_at", kind: "date" },
      lastExitAt: { col: "last_exit_at", kind: "date" },
      lastExitReason: { col: "last_exit_reason", kind: "str" },
      lastError: { col: "last_error", kind: "str" },
      nextRestartAt: { col: "next_restart_at", kind: "date" },
      updatedAt: { col: "updated_at", kind: "date" },
    };

    const setClauses: string[] = [];
    const values: Record<string, unknown> = { id: instanceId };
    let touched = false;

    for (const [key, value] of Object.entries(patch)) {
      const entry = map[key];
      if (!entry) continue;
      touched = true;
      const param = `p_${entry.col}`;
      setClauses.push(`${entry.col} = @${param}`);
      if (value === undefined) {
        values[param] = null;
      } else if (entry.kind === "date") {
        values[param] = dateToStr(value);
      } else {
        values[param] = value;
      }
    }

    // Always bump updated_at on a change.
    if (touched && !("updatedAt" in patch)) {
      setClauses.push("updated_at = @p_updated_at");
      values.p_updated_at = new Date().toISOString();
    }

    if (setClauses.length === 0) return;
    this.prep(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE id = @id`).run(values);
  }

  async listInstances(filter?: BeaconInstanceFilter): Promise<BeaconInstance[]> {
    const rows = filter?.beaconName
      ? (this.prep(
          `SELECT * FROM ${this.table} WHERE beacon_name = ? ORDER BY id ASC`,
        ).all(filter.beaconName) as Record<string, unknown>[])
      : (this.prep(`SELECT * FROM ${this.table} ORDER BY id ASC`).all() as Record<string, unknown>[]);
    return rows.map(rowToInstance);
  }

  async removeInstance(instanceId: string): Promise<void> {
    this.prep(`DELETE FROM ${this.table} WHERE id = ?`).run(instanceId);
    this.prep(`DELETE FROM ${this.eventsTable} WHERE instance_id = ?`).run(instanceId);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    const seq = (this.prep(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${this.eventsTable}`).get() as { next: number }).next;
    this.prep(`
      INSERT INTO ${this.eventsTable} (id, instance_id, beacon_name, incarnation, type, message, at, seq)
      VALUES (@id, @instance_id, @beacon_name, @incarnation, @type, @message, @at, @seq)
    `).run({
      id: event.id,
      instance_id: event.instanceId,
      beacon_name: event.beaconName,
      incarnation: event.incarnation,
      type: event.type,
      message: event.message ?? null,
      at: dateToStr(event.at),
      seq,
    });
    // Prune this instance's oldest events beyond the retention cap. The subquery
    // returns the seq of the maxEvents-th newest row (via LIMIT 1 OFFSET
    // maxEvents); rows at/below it are deleted. When the instance has <=
    // maxEvents rows the subquery yields no row → NULL → `seq <= NULL` deletes
    // nothing.
    this.prep(
      `DELETE FROM ${this.eventsTable}
       WHERE instance_id = ?
         AND seq <= (
           SELECT seq FROM ${this.eventsTable}
           WHERE instance_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
         )`,
    ).run(event.instanceId, event.instanceId, this.maxEvents);
  }

  async listEvents(instanceId: string, limit = 100): Promise<BeaconEvent[]> {
    const rows = this.prep(
      `SELECT * FROM ${this.eventsTable} WHERE instance_id = ? ORDER BY seq DESC LIMIT ?`,
    ).all(instanceId, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  async listBeaconEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    const rows = this.prep(
      `SELECT * FROM ${this.eventsTable} WHERE beacon_name = ? ORDER BY seq DESC LIMIT ?`,
    ).all(beaconName, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
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
    startedAt: strToDate(row.started_at),
    readyAt: strToDate(row.ready_at),
    lastHeartbeatAt: strToDate(row.last_heartbeat_at),
    lastExitAt: strToDate(row.last_exit_at),
    lastExitReason: (row.last_exit_reason as BeaconInstance["lastExitReason"] | null) ?? undefined,
    lastError: (row.last_error as string | null) ?? undefined,
    nextRestartAt: strToDate(row.next_restart_at),
    createdAt: strToDate(row.created_at)!,
    updatedAt: strToDate(row.updated_at)!,
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
    at: strToDate(row.at)!,
  };
}
