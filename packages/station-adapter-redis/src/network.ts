import Redis from "ioredis";
import type {
  ControllerLease, StationHeartbeat, StationListFilter,
  StationNetworkAdapter, StationNode,
} from "station-network";

export interface StationNetworkRedisOptions { url?: string; redis?: Redis; prefix?: string; }

const ACQUIRE_LUA = `
local currentHolder = redis.call('HGET', KEYS[1], 'holderId')
local currentToken = redis.call('HGET', KEYS[1], 'token')
local currentExpiry = redis.call('HGET', KEYS[1], 'expiresAt')
if currentExpiry and tonumber(currentExpiry) > tonumber(ARGV[4]) and
   (currentHolder ~= ARGV[1] or currentToken ~= ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], 'holderId', ARGV[1], 'token', ARGV[2], 'expiresAt', ARGV[3])
return 1`;
const RENEW_LUA = `
if redis.call('HGET', KEYS[1], 'holderId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'token') ~= ARGV[2] then return 0 end
local currentExpiry = redis.call('HGET', KEYS[1], 'expiresAt')
if not currentExpiry or tonumber(currentExpiry) <= tonumber(ARGV[4]) then return 0 end
redis.call('HSET', KEYS[1], 'expiresAt', ARGV[3]); return 1`;
const RELEASE_LUA = `
if redis.call('HGET', KEYS[1], 'holderId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'token') ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1]); return 1`;

export class StationNetworkRedisAdapter implements StationNetworkAdapter {
  private redis: Redis; private owns: boolean; private prefix: string;
  constructor(options: StationNetworkRedisOptions = {}) {
    this.redis=options.redis ?? new Redis(options.url ?? "redis://localhost:6379",{maxRetriesPerRequest:3});
    this.owns=!options.redis; this.prefix=options.prefix ?? "station";
  }
  private stationKey(id:string){return `${this.prefix}:network:station:${id}`;}
  private stationSet(){return `${this.prefix}:network:stations`;}
  private leaseKey(name:string){return `${this.prefix}:network:controller:${name}`;}

  async upsertStation(s: StationNode): Promise<void> {
    const p=this.redis.multi(); p.hset(this.stationKey(s.id),toHash(s)); p.sadd(this.stationSet(),s.id); await p.exec();
  }
  async getStation(id:string):Promise<StationNode|null>{const h=await this.redis.hgetall(this.stationKey(id));return Object.keys(h).length?fromHash(h):null;}
  async listStations(filter?:StationListFilter):Promise<StationNode[]>{
    const ids=await this.redis.smembers(this.stationSet()); if(!ids.length)return[];
    const p=this.redis.pipeline(); ids.forEach(id=>p.hgetall(this.stationKey(id))); const rows=await p.exec();
    return (rows??[]).flatMap(([e,h])=>!e&&h&&Object.keys(h as object).length?[fromHash(h as Record<string,string>)]:[])
      .filter(s=>!filter?.networkId||s.networkId===filter.networkId).filter(s=>!filter?.status||s.status===filter.status)
      .filter(s=>!filter?.role||s.role===filter.role).sort((a,b)=>a.name.localeCompare(b.name));
  }
  async heartbeat(id:string,h:StationHeartbeat):Promise<boolean>{
    if(!(await this.redis.exists(this.stationKey(id))))return false;
    const fields:Record<string,string>={status:h.status,capacity:JSON.stringify(h.capacity),definitions:JSON.stringify(h.definitions),lastHeartbeatAt:h.lastHeartbeatAt.toISOString(),leaseExpiresAt:h.leaseExpiresAt.toISOString()};
    if(h.labels)fields.labels=JSON.stringify(h.labels);if(h.version)fields.version=h.version;if(h.endpoint)fields.endpoint=h.endpoint;
    await this.redis.hset(this.stationKey(id),fields);return true;
  }
  async removeStation(id:string):Promise<void>{const p=this.redis.multi();p.del(this.stationKey(id));p.srem(this.stationSet(),id);await p.exec();}
  async markOfflineBefore(cutoff:Date,networkId?:string):Promise<number>{
    const list=await this.listStations({networkId});let n=0;const p=this.redis.multi();
    for(const s of list)if(s.status!=="offline"&&s.leaseExpiresAt<=cutoff){p.hset(this.stationKey(s.id),"status","offline");n++;}
    if(n)await p.exec();return n;
  }
  async acquireControllerLease(l:ControllerLease,now:Date):Promise<boolean>{const r=await this.redis.eval(ACQUIRE_LUA,1,this.leaseKey(l.name),l.holderId,l.token,String(l.expiresAt.getTime()),String(now.getTime()));return Number(r)===1;}
  async renewControllerLease(name:string,holderId:string,token:string,expiresAt:Date,now=new Date()):Promise<boolean>{const r=await this.redis.eval(RENEW_LUA,1,this.leaseKey(name),holderId,token,String(expiresAt.getTime()),String(now.getTime()));return Number(r)===1;}
  async releaseControllerLease(name:string,holderId:string,token:string):Promise<boolean>{const r=await this.redis.eval(RELEASE_LUA,1,this.leaseKey(name),holderId,token);return Number(r)===1;}
  async getControllerLease(name:string):Promise<ControllerLease|null>{const h=await this.redis.hgetall(this.leaseKey(name));return Object.keys(h).length?{name,holderId:h.holderId,token:h.token,expiresAt:new Date(Number(h.expiresAt))}:null;}
  async ping():Promise<boolean>{try{return await this.redis.ping()==="PONG";}catch{return false;}}
  async close():Promise<void>{if(this.owns)await this.redis.quit();}
}
function toHash(s:StationNode):Record<string,string>{return{id:s.id,networkId:s.networkId,name:s.name,role:s.role,status:s.status,labels:JSON.stringify(s.labels),capacity:JSON.stringify(s.capacity),definitions:JSON.stringify(s.definitions),...(s.version?{version:s.version}:{}),...(s.endpoint?{endpoint:s.endpoint}:{}),startedAt:s.startedAt.toISOString(),lastHeartbeatAt:s.lastHeartbeatAt.toISOString(),leaseExpiresAt:s.leaseExpiresAt.toISOString()};}
function fromHash(h:Record<string,string>):StationNode{return{id:h.id,networkId:h.networkId,name:h.name,role:h.role as StationNode["role"],status:h.status as StationNode["status"],labels:JSON.parse(h.labels),capacity:JSON.parse(h.capacity),definitions:JSON.parse(h.definitions),version:h.version||undefined,endpoint:h.endpoint||undefined,startedAt:new Date(h.startedAt),lastHeartbeatAt:new Date(h.lastHeartbeatAt),leaseExpiresAt:new Date(h.leaseExpiresAt)};}
