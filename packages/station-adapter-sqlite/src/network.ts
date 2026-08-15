import Database from "better-sqlite3";
import type {
  ControllerLease,
  StationHeartbeat,
  StationListFilter,
  StationNetworkAdapter,
  StationNode,
} from "station-network";

export interface StationNetworkSqliteOptions {
  dbPath?: string;
  tablePrefix?: string;
}

const VALID_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class StationNetworkSqliteAdapter implements StationNetworkAdapter {
  private db: Database.Database;
  private stationsTable: string;
  private leasesTable: string;

  constructor(options: StationNetworkSqliteOptions = {}) {
    const prefix = options.tablePrefix ?? "station_network";
    if (!VALID_NAME.test(prefix)) throw new Error(`Invalid tablePrefix "${prefix}".`);
    this.stationsTable = `${prefix}_stations`;
    this.leasesTable = `${prefix}_controller_leases`;
    this.db = new Database(options.dbPath ?? "station.db");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.stationsTable} (
        id TEXT PRIMARY KEY,
        network_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        labels TEXT NOT NULL,
        capacity TEXT NOT NULL,
        definitions TEXT NOT NULL,
        version TEXT,
        endpoint TEXT,
        started_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.stationsTable}_network
        ON ${this.stationsTable} (network_id, status);
      CREATE TABLE IF NOT EXISTS ${this.leasesTable} (
        name TEXT PRIMARY KEY,
        holder_id TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
  }

  async upsertStation(station: StationNode): Promise<void> {
    this.db.prepare(`
      INSERT INTO ${this.stationsTable}
        (id, network_id, name, role, status, labels, capacity, definitions,
         version, endpoint, started_at, last_heartbeat_at, lease_expires_at)
      VALUES (@id, @network_id, @name, @role, @status, @labels, @capacity, @definitions,
              @version, @endpoint, @started_at, @last_heartbeat_at, @lease_expires_at)
      ON CONFLICT(id) DO UPDATE SET
        network_id=excluded.network_id, name=excluded.name, role=excluded.role,
        status=excluded.status, labels=excluded.labels, capacity=excluded.capacity,
        definitions=excluded.definitions, version=excluded.version, endpoint=excluded.endpoint,
        started_at=excluded.started_at, last_heartbeat_at=excluded.last_heartbeat_at,
        lease_expires_at=excluded.lease_expires_at
    `).run(toRow(station));
  }

  async getStation(id: string): Promise<StationNode | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.stationsTable} WHERE id = ?`).get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  async listStations(filter?: StationListFilter): Promise<StationNode[]> {
    const where: string[] = [];
    const values: string[] = [];
    if (filter?.networkId) { where.push("network_id = ?"); values.push(filter.networkId); }
    if (filter?.status) { where.push("status = ?"); values.push(filter.status); }
    if (filter?.role) { where.push("role = ?"); values.push(filter.role); }
    const sql = `SELECT * FROM ${this.stationsTable}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name`;
    return (this.db.prepare(sql).all(...values) as Row[]).map(fromRow);
  }

  async heartbeat(id: string, heartbeat: StationHeartbeat): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE ${this.stationsTable} SET status=@status, labels=COALESCE(@labels, labels),
        capacity=@capacity, definitions=@definitions, version=COALESCE(@version, version),
        endpoint=COALESCE(@endpoint, endpoint), last_heartbeat_at=@last_heartbeat_at,
        lease_expires_at=@lease_expires_at WHERE id=@id
    `).run({
      id,
      status: heartbeat.status,
      labels: heartbeat.labels ? JSON.stringify(heartbeat.labels) : null,
      capacity: JSON.stringify(heartbeat.capacity),
      definitions: JSON.stringify(heartbeat.definitions),
      version: heartbeat.version ?? null,
      endpoint: heartbeat.endpoint ?? null,
      last_heartbeat_at: heartbeat.lastHeartbeatAt.toISOString(),
      lease_expires_at: heartbeat.leaseExpiresAt.toISOString(),
    });
    return result.changes === 1;
  }

  async removeStation(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${this.stationsTable} WHERE id = ?`).run(id);
  }

  async markOfflineBefore(cutoff: Date, networkId?: string): Promise<number> {
    const result = networkId
      ? this.db.prepare(`UPDATE ${this.stationsTable} SET status='offline' WHERE network_id=? AND status!='offline' AND lease_expires_at<=?`).run(networkId, cutoff.toISOString())
      : this.db.prepare(`UPDATE ${this.stationsTable} SET status='offline' WHERE status!='offline' AND lease_expires_at<=?`).run(cutoff.toISOString());
    return result.changes;
  }

  async acquireControllerLease(lease: ControllerLease, now: Date): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT INTO ${this.leasesTable} (name, holder_id, token, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET holder_id=excluded.holder_id,
        token=excluded.token, expires_at=excluded.expires_at
      WHERE ${this.leasesTable}.expires_at <= ? OR
        (${this.leasesTable}.holder_id = excluded.holder_id AND ${this.leasesTable}.token = excluded.token)
    `).run(lease.name, lease.holderId, lease.token, lease.expiresAt.toISOString(), now.toISOString());
    return result.changes === 1;
  }

  async renewControllerLease(name: string, holderId: string, token: string, expiresAt: Date, now = new Date()): Promise<boolean> {
    return this.db.prepare(`UPDATE ${this.leasesTable} SET expires_at=? WHERE name=? AND holder_id=? AND token=? AND expires_at>?`)
      .run(expiresAt.toISOString(), name, holderId, token, now.toISOString()).changes === 1;
  }

  async releaseControllerLease(name: string, holderId: string, token: string): Promise<boolean> {
    return this.db.prepare(`DELETE FROM ${this.leasesTable} WHERE name=? AND holder_id=? AND token=?`)
      .run(name, holderId, token).changes === 1;
  }

  async getControllerLease(name: string): Promise<ControllerLease | null> {
    const row = this.db.prepare(`SELECT * FROM ${this.leasesTable} WHERE name=?`).get(name) as LeaseRow | undefined;
    return row ? { name: row.name, holderId: row.holder_id, token: row.token, expiresAt: new Date(row.expires_at) } : null;
  }

  async ping(): Promise<boolean> { return true; }
  async close(): Promise<void> { this.db.close(); }
}

interface Row {
  id: string; network_id: string; name: string; role: StationNode["role"];
  status: StationNode["status"]; labels: string; capacity: string; definitions: string;
  version: string | null; endpoint: string | null; started_at: string;
  last_heartbeat_at: string; lease_expires_at: string;
}
interface LeaseRow { name: string; holder_id: string; token: string; expires_at: string; }

function toRow(station: StationNode) {
  return {
    id: station.id, network_id: station.networkId, name: station.name, role: station.role,
    status: station.status, labels: JSON.stringify(station.labels), capacity: JSON.stringify(station.capacity),
    definitions: JSON.stringify(station.definitions), version: station.version ?? null,
    endpoint: station.endpoint ?? null, started_at: station.startedAt.toISOString(),
    last_heartbeat_at: station.lastHeartbeatAt.toISOString(), lease_expires_at: station.leaseExpiresAt.toISOString(),
  };
}

function fromRow(row: Row): StationNode {
  return {
    id: row.id, networkId: row.network_id, name: row.name, role: row.role, status: row.status,
    labels: JSON.parse(row.labels), capacity: JSON.parse(row.capacity), definitions: JSON.parse(row.definitions),
    version: row.version ?? undefined, endpoint: row.endpoint ?? undefined, startedAt: new Date(row.started_at),
    lastHeartbeatAt: new Date(row.last_heartbeat_at), leaseExpiresAt: new Date(row.lease_expires_at),
  };
}
