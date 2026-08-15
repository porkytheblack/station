import pg from "pg";
import type {
  ControllerLease, StationHeartbeat, StationListFilter,
  StationNetworkAdapter, StationNode,
} from "station-network";
import { validateTableName } from "./shared.js";

export interface StationNetworkPostgresOptions {
  connectionString?: string;
  pool?: pg.Pool;
  tablePrefix?: string;
}

export class StationNetworkPostgresAdapter implements StationNetworkAdapter {
  private pool: pg.Pool;
  private ownsPool: boolean;
  private stationsTable: string;
  private leasesTable: string;
  private initialized: Promise<void>;

  constructor(options: StationNetworkPostgresOptions = {}) {
    const prefix = validateTableName(options.tablePrefix ?? "station_network");
    this.stationsTable = `${prefix}_stations`;
    this.leasesTable = `${prefix}_controller_leases`;
    this.pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
    this.ownsPool = !options.pool;
    this.initialized = this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.stationsTable} (
        id TEXT PRIMARY KEY, network_id TEXT NOT NULL, name TEXT NOT NULL,
        role TEXT NOT NULL, status TEXT NOT NULL, labels JSONB NOT NULL,
        capacity JSONB NOT NULL, definitions JSONB NOT NULL, version TEXT,
        endpoint TEXT, started_at TIMESTAMPTZ NOT NULL,
        last_heartbeat_at TIMESTAMPTZ NOT NULL, lease_expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_${this.stationsTable}_network
        ON ${this.stationsTable} (network_id, status);
      CREATE TABLE IF NOT EXISTS ${this.leasesTable} (
        name TEXT PRIMARY KEY, holder_id TEXT NOT NULL, token TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
  }
  private async ready() { await this.initialized; }

  async upsertStation(s: StationNode): Promise<void> {
    await this.ready();
    await this.pool.query(`
      INSERT INTO ${this.stationsTable}
        (id,network_id,name,role,status,labels,capacity,definitions,version,endpoint,
         started_at,last_heartbeat_at,lease_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(id) DO UPDATE SET network_id=EXCLUDED.network_id,name=EXCLUDED.name,
        role=EXCLUDED.role,status=EXCLUDED.status,labels=EXCLUDED.labels,
        capacity=EXCLUDED.capacity,definitions=EXCLUDED.definitions,version=EXCLUDED.version,
        endpoint=EXCLUDED.endpoint,started_at=EXCLUDED.started_at,
        last_heartbeat_at=EXCLUDED.last_heartbeat_at,lease_expires_at=EXCLUDED.lease_expires_at`,
      [s.id,s.networkId,s.name,s.role,s.status,s.labels,s.capacity,s.definitions,s.version ?? null,
        s.endpoint ?? null,s.startedAt,s.lastHeartbeatAt,s.leaseExpiresAt]);
  }

  async getStation(id: string): Promise<StationNode | null> {
    await this.ready();
    const result = await this.pool.query(`SELECT * FROM ${this.stationsTable} WHERE id=$1`, [id]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async listStations(filter?: StationListFilter): Promise<StationNode[]> {
    await this.ready();
    const where: string[] = []; const values: string[] = [];
    if (filter?.networkId) { values.push(filter.networkId); where.push(`network_id=$${values.length}`); }
    if (filter?.status) { values.push(filter.status); where.push(`status=$${values.length}`); }
    if (filter?.role) { values.push(filter.role); where.push(`role=$${values.length}`); }
    const result = await this.pool.query(`SELECT * FROM ${this.stationsTable}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY name`, values);
    return result.rows.map(fromRow);
  }

  async heartbeat(id: string, h: StationHeartbeat): Promise<boolean> {
    await this.ready();
    const result = await this.pool.query(`UPDATE ${this.stationsTable} SET
      status=$2,labels=COALESCE($3,labels),capacity=$4,definitions=$5,
      version=COALESCE($6,version),endpoint=COALESCE($7,endpoint),
      last_heartbeat_at=$8,lease_expires_at=$9 WHERE id=$1`,
      [id,h.status,h.labels ?? null,h.capacity,h.definitions,h.version ?? null,h.endpoint ?? null,
        h.lastHeartbeatAt,h.leaseExpiresAt]);
    return result.rowCount === 1;
  }

  async removeStation(id: string): Promise<void> { await this.ready(); await this.pool.query(`DELETE FROM ${this.stationsTable} WHERE id=$1`, [id]); }

  async markOfflineBefore(cutoff: Date, networkId?: string): Promise<number> {
    await this.ready();
    const result = networkId
      ? await this.pool.query(`UPDATE ${this.stationsTable} SET status='offline' WHERE network_id=$1 AND status!='offline' AND lease_expires_at<=$2`, [networkId,cutoff])
      : await this.pool.query(`UPDATE ${this.stationsTable} SET status='offline' WHERE status!='offline' AND lease_expires_at<=$1`, [cutoff]);
    return result.rowCount ?? 0;
  }

  async acquireControllerLease(l: ControllerLease, now: Date): Promise<boolean> {
    await this.ready();
    const result = await this.pool.query(`
      INSERT INTO ${this.leasesTable}(name,holder_id,token,expires_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(name) DO UPDATE SET holder_id=EXCLUDED.holder_id,token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE ${this.leasesTable}.expires_at <= $5 OR
        (${this.leasesTable}.holder_id=EXCLUDED.holder_id AND ${this.leasesTable}.token=EXCLUDED.token)
      RETURNING name`, [l.name,l.holderId,l.token,l.expiresAt,now]);
    return result.rowCount === 1;
  }

  async renewControllerLease(name: string, holderId: string, token: string, expiresAt: Date, now = new Date()): Promise<boolean> {
    await this.ready();
    const r=await this.pool.query(`UPDATE ${this.leasesTable} SET expires_at=$4 WHERE name=$1 AND holder_id=$2 AND token=$3 AND expires_at>$5`,[name,holderId,token,expiresAt,now]); return r.rowCount===1;
  }
  async releaseControllerLease(name: string, holderId: string, token: string): Promise<boolean> {
    await this.ready(); const r=await this.pool.query(`DELETE FROM ${this.leasesTable} WHERE name=$1 AND holder_id=$2 AND token=$3`,[name,holderId,token]); return r.rowCount===1;
  }
  async getControllerLease(name: string): Promise<ControllerLease | null> {
    await this.ready(); const r=await this.pool.query(`SELECT * FROM ${this.leasesTable} WHERE name=$1`,[name]);
    const row=r.rows[0]; return row ? {name:row.name,holderId:row.holder_id,token:row.token,expiresAt:new Date(row.expires_at)} : null;
  }
  async ping(): Promise<boolean> { try { await this.ready(); await this.pool.query("SELECT 1"); return true; } catch { return false; } }
  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }
}

function fromRow(row: Record<string, unknown>): StationNode {
  return {
    id:String(row.id),networkId:String(row.network_id),name:String(row.name),
    role:row.role as StationNode["role"],status:row.status as StationNode["status"],
    labels:row.labels as Record<string,string>,capacity:row.capacity as StationNode["capacity"],
    definitions:row.definitions as StationNode["definitions"],version:row.version ? String(row.version) : undefined,
    endpoint:row.endpoint ? String(row.endpoint) : undefined,startedAt:new Date(row.started_at as string),
    lastHeartbeatAt:new Date(row.last_heartbeat_at as string),leaseExpiresAt:new Date(row.lease_expires_at as string),
  };
}
