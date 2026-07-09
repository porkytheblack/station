import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  BeaconStateAdapter,
  BeaconInstance,
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
}

/** Durable {@link BeaconStateAdapter} backed by SQLite (better-sqlite3). */
export class BeaconSqliteAdapter implements BeaconStateAdapter {
  private db: Database.Database;
  private table: string;
  private eventsTable: string;

  constructor(options: BeaconSqliteAdapterOptions = {}) {
    const dbPath = options.dbPath ?? "station.db";
    this.table = validateTableName(options.tableName ?? "beacon_instances");
    this.eventsTable = validateTableName(options.eventsTableName ?? "beacon_events");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        beacon_name        TEXT PRIMARY KEY,
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
        beacon_name TEXT NOT NULL,
        incarnation INTEGER NOT NULL,
        type        TEXT NOT NULL,
        message     TEXT,
        at          TEXT NOT NULL,
        seq         INTEGER
      )
    `);

    // Monotonic sequence so events for a beacon list newest-first even when the
    // `at` timestamps collide (same-millisecond bursts).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.eventsTable}_beacon
        ON ${this.eventsTable} (beacon_name, seq)
    `);
  }

  async upsertInstance(instance: BeaconInstance): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO ${this.table}
        (beacon_name, status, desired_state, incarnation, restart_count, pid, config,
         started_at, ready_at, last_heartbeat_at, last_exit_at, last_exit_reason,
         last_error, next_restart_at, created_at, updated_at)
      VALUES
        (@beacon_name, @status, @desired_state, @incarnation, @restart_count, @pid, @config,
         @started_at, @ready_at, @last_heartbeat_at, @last_exit_at, @last_exit_reason,
         @last_error, @next_restart_at, @created_at, @updated_at)
    `).run({
      beacon_name: instance.beaconName,
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

  async getInstance(beaconName: string): Promise<BeaconInstance | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE beacon_name = ?`).get(beaconName) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToInstance(row) : null;
  }

  async updateInstance(beaconName: string, patch: BeaconInstancePatch): Promise<void> {
    const map: Record<string, { col: string; kind: "str" | "num" | "date" }> = {
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
    const values: Record<string, unknown> = { beacon_name: beaconName };
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
    this.db.prepare(`UPDATE ${this.table} SET ${setClauses.join(", ")} WHERE beacon_name = @beacon_name`).run(values);
  }

  async listInstances(): Promise<BeaconInstance[]> {
    const rows = this.db.prepare(`SELECT * FROM ${this.table} ORDER BY beacon_name ASC`).all() as Record<string, unknown>[];
    return rows.map(rowToInstance);
  }

  async removeInstance(beaconName: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.table} WHERE beacon_name = ?`).run(beaconName);
  }

  async addEvent(event: BeaconEvent): Promise<void> {
    const seq = (this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${this.eventsTable}`).get() as { next: number }).next;
    this.db.prepare(`
      INSERT INTO ${this.eventsTable} (id, beacon_name, incarnation, type, message, at, seq)
      VALUES (@id, @beacon_name, @incarnation, @type, @message, @at, @seq)
    `).run({
      id: event.id,
      beacon_name: event.beaconName,
      incarnation: event.incarnation,
      type: event.type,
      message: event.message ?? null,
      at: dateToStr(event.at),
      seq,
    });
  }

  async listEvents(beaconName: string, limit = 100): Promise<BeaconEvent[]> {
    const rows = this.db.prepare(
      `SELECT * FROM ${this.eventsTable} WHERE beacon_name = ? ORDER BY seq DESC LIMIT ?`,
    ).all(beaconName, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
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

function rowToInstance(row: Record<string, unknown>): BeaconInstance {
  return {
    beaconName: row.beacon_name as string,
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
    beaconName: row.beacon_name as string,
    incarnation: Number(row.incarnation),
    type: row.type as BeaconEvent["type"],
    message: (row.message as string | null) ?? undefined,
    at: strToDate(row.at)!,
  };
}
