import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  ControllerLease, StationHeartbeat, StationListFilter,
  StationNetworkAdapter, StationNode,
} from "station-network";
import { dateToStr, runIdempotentDdl, validateTableName } from "./shared.js";

export interface StationNetworkMysqlOptions { connectionString?:string; pool?:Pool; tablePrefix?:string; }

export class StationNetworkMysqlAdapter implements StationNetworkAdapter {
  private constructor(private pool:Pool,private owns:boolean,private stations:string,private leases:string){}
  static async create(options:StationNetworkMysqlOptions={}):Promise<StationNetworkMysqlAdapter>{
    const prefix=validateTableName(options.tablePrefix??"station_network");
    const stations=`${prefix}_stations`,leases=`${prefix}_controller_leases`;
    if(!options.pool&&!options.connectionString)throw new Error("StationNetworkMysqlAdapter requires connectionString or pool.");
    const pool=options.pool??mysql.createPool(options.connectionString!);
    await pool.execute(`CREATE TABLE IF NOT EXISTS ${stations}(
      id VARCHAR(255) PRIMARY KEY,network_id VARCHAR(255) NOT NULL,name VARCHAR(255) NOT NULL,
      role VARCHAR(32) NOT NULL,status VARCHAR(32) NOT NULL,labels JSON NOT NULL,capacity JSON NOT NULL,
      definitions JSON NOT NULL,version VARCHAR(255),endpoint TEXT,started_at DATETIME(3) NOT NULL,
      last_heartbeat_at DATETIME(3) NOT NULL,lease_expires_at DATETIME(3) NOT NULL)`);
    await runIdempotentDdl(sql=>pool.execute(sql),`CREATE INDEX idx_${stations}_network ON ${stations}(network_id,status)`);
    await pool.execute(`CREATE TABLE IF NOT EXISTS ${leases}(
      name VARCHAR(255) PRIMARY KEY,holder_id VARCHAR(255) NOT NULL,token VARCHAR(64) NOT NULL,expires_at DATETIME(3) NOT NULL)`);
    return new StationNetworkMysqlAdapter(pool,!options.pool,stations,leases);
  }
  async upsertStation(s:StationNode):Promise<void>{await this.pool.execute(`INSERT INTO ${this.stations}
    (id,network_id,name,role,status,labels,capacity,definitions,version,endpoint,started_at,last_heartbeat_at,lease_expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE network_id=VALUES(network_id),name=VALUES(name),
    role=VALUES(role),status=VALUES(status),labels=VALUES(labels),capacity=VALUES(capacity),definitions=VALUES(definitions),
    version=VALUES(version),endpoint=VALUES(endpoint),started_at=VALUES(started_at),last_heartbeat_at=VALUES(last_heartbeat_at),lease_expires_at=VALUES(lease_expires_at)`,
    [s.id,s.networkId,s.name,s.role,s.status,JSON.stringify(s.labels),JSON.stringify(s.capacity),JSON.stringify(s.definitions),s.version??null,s.endpoint??null,dateToStr(s.startedAt),dateToStr(s.lastHeartbeatAt),dateToStr(s.leaseExpiresAt)]);}
  async getStation(id:string):Promise<StationNode|null>{const[rows]=await this.pool.execute<RowDataPacket[]>(`SELECT * FROM ${this.stations} WHERE id=?`,[id]);return rows[0]?fromRow(rows[0]):null;}
  async listStations(f?:StationListFilter):Promise<StationNode[]>{const w:string[]=[],v:string[]=[];if(f?.networkId){w.push("network_id=?");v.push(f.networkId);}if(f?.status){w.push("status=?");v.push(f.status);}if(f?.role){w.push("role=?");v.push(f.role);}const[rows]=await this.pool.execute<RowDataPacket[]>(`SELECT * FROM ${this.stations}${w.length?` WHERE ${w.join(" AND ")}`:""} ORDER BY name`,v);return rows.map(fromRow);}
  async heartbeat(id:string,h:StationHeartbeat):Promise<boolean>{const[r]=await this.pool.execute<ResultSetHeader>(`UPDATE ${this.stations} SET status=?,labels=COALESCE(?,labels),capacity=?,definitions=?,version=COALESCE(?,version),endpoint=COALESCE(?,endpoint),last_heartbeat_at=?,lease_expires_at=? WHERE id=?`,[h.status,h.labels?JSON.stringify(h.labels):null,JSON.stringify(h.capacity),JSON.stringify(h.definitions),h.version??null,h.endpoint??null,dateToStr(h.lastHeartbeatAt),dateToStr(h.leaseExpiresAt),id]);return r.affectedRows===1;}
  async removeStation(id:string):Promise<void>{await this.pool.execute(`DELETE FROM ${this.stations} WHERE id=?`,[id]);}
  async markOfflineBefore(cutoff:Date,networkId?:string):Promise<number>{const[r]=await this.pool.execute<ResultSetHeader>(`UPDATE ${this.stations} SET status='offline' WHERE status!='offline' AND lease_expires_at<=?${networkId?" AND network_id=?":""}`,[dateToStr(cutoff),...(networkId?[networkId]:[])]);return r.affectedRows;}
  async acquireControllerLease(l:ControllerLease,now:Date):Promise<boolean>{
    await this.pool.execute(`INSERT INTO ${this.leases}(name,holder_id,token,expires_at) VALUES(?,?,?,?)
      ON DUPLICATE KEY UPDATE holder_id=IF(expires_at<=? OR (holder_id=VALUES(holder_id) AND token=VALUES(token)),VALUES(holder_id),holder_id),
      token=IF(expires_at<=? OR (holder_id=VALUES(holder_id) AND token=VALUES(token)),VALUES(token),token),
      expires_at=IF(expires_at<=? OR (holder_id=VALUES(holder_id) AND token=VALUES(token)),VALUES(expires_at),expires_at)`,
      [l.name,l.holderId,l.token,dateToStr(l.expiresAt),dateToStr(now),dateToStr(now),dateToStr(now)]);
    const got=await this.getControllerLease(l.name);return got?.holderId===l.holderId&&got.token===l.token;
  }
  async renewControllerLease(name:string,holderId:string,token:string,expiresAt:Date,now=new Date()):Promise<boolean>{const[r]=await this.pool.execute<ResultSetHeader>(`UPDATE ${this.leases} SET expires_at=? WHERE name=? AND holder_id=? AND token=? AND expires_at>?`,[dateToStr(expiresAt),name,holderId,token,dateToStr(now)]);return r.affectedRows===1;}
  async releaseControllerLease(name:string,holderId:string,token:string):Promise<boolean>{const[r]=await this.pool.execute<ResultSetHeader>(`DELETE FROM ${this.leases} WHERE name=? AND holder_id=? AND token=?`,[name,holderId,token]);return r.affectedRows===1;}
  async getControllerLease(name:string):Promise<ControllerLease|null>{const[rows]=await this.pool.execute<RowDataPacket[]>(`SELECT * FROM ${this.leases} WHERE name=?`,[name]);const r=rows[0];return r?{name:String(r.name),holderId:String(r.holder_id),token:String(r.token),expiresAt:new Date(r.expires_at as string)}:null;}
  async ping():Promise<boolean>{try{await this.pool.execute("SELECT 1");return true;}catch{return false;}}
  async close():Promise<void>{if(this.owns)await this.pool.end();}
}
function json(v:unknown){return typeof v==="string"?JSON.parse(v):v;}
function fromRow(r:RowDataPacket):StationNode{return{id:String(r.id),networkId:String(r.network_id),name:String(r.name),role:r.role,status:r.status,labels:json(r.labels),capacity:json(r.capacity),definitions:json(r.definitions),version:r.version?String(r.version):undefined,endpoint:r.endpoint?String(r.endpoint):undefined,startedAt:new Date(r.started_at),lastHeartbeatAt:new Date(r.last_heartbeat_at),leaseExpiresAt:new Date(r.lease_expires_at)};}
