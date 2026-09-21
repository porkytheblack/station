import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { MemoryAdapter } from "station-signal";
import { StationNetworkMemoryAdapter } from "station-network";
import { ImageRegistry, MemoryRegistryMetadataAdapter, MemoryRegistryBlobAdapter, digestBytes, type ImageManifest } from "station-images";
import { KeyStore, MemoryKeyStorage } from "../../src/server/auth/keys.js";
import { createStation } from "../../src/server/index.js";
import { resolveConfig } from "../../src/config/schema.js";
import { createTenantRegistryWorkerGateway } from "../../src/registry/worker-gateway.js";
import type { TenantImageRegistryConfig } from "../../src/registry/tenants.js";
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));
const image = process.env.STATION_IMAGE_DOCKER_IMAGE;
async function freePort(){const server=createServer();await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});const address=server.address();assert.ok(address&&typeof address!=="string");await new Promise<void>(resolve=>server.close(()=>resolve()));return address.port;}
async function waitFor<T>(read:()=>Promise<T|undefined>,label:string){const deadline=Date.now()+30_000;while(Date.now()<deadline){const value=await read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error(`Timed out: ${label}`);}

test("tenant registry publication executes only on its fixed dedicated Docker worker",{skip:!image,timeout:120_000},async t=>{
 const root=await mkdtemp(join(tmpdir(),"station-tenant-images-")),stations:Awaited<ReturnType<typeof createStation>>[]=[];
 t.after(async()=>{for(const station of stations.reverse())await station.stop();await rm(root,{recursive:true,force:true});});
 const namespaces:TenantImageRegistryConfig["namespaces"]={},workers=new Map<string,{url:string,key:string,queue:MemoryAdapter}>();
 const old=process.env.IMAGE_HOST_ONLY;process.env.IMAGE_HOST_ONLY="never-forwarded";t.after(()=>{if(old===undefined)delete process.env.IMAGE_HOST_ONLY;else process.env.IMAGE_HOST_ONLY=old});
 for(const tenantId of ["a","b"]){
  const source=new ImageRegistry({maxBlobBytes:64*1024,storage:{id:`tenant-source-${tenantId}`,metadata:new MemoryRegistryMetadataAdapter(),blobs:new MemoryRegistryBlobAdapter()}});
  const port=await freePort(),queue=new MemoryAdapter(),workerId=`worker-${tenantId}`;
  const station=await createStation(resolveConfig({role:"station",host:"127.0.0.1",port,stationDir:workerId,adapter:queue,auth:{username:"operator",password:"fixture-only-password",keyStorage:new MemoryKeyStorage()},runner:{pollIntervalMs:20},network:{stationId:workerId,adapter:new StationNetworkMemoryAdapter(),heartbeatIntervalMs:30},registry:{tenantId,execution:{allowedEnv:["IMAGE_TOKEN"],backend:{kind:"docker",options:{image:image!,rootDir:join(root,`containers-${tenantId}`),executable:process.env.STATION_IMAGE_DOCKER_EXECUTABLE??"/usr/local/bin/docker",target:{os:"linux",arch:process.env.STATION_IMAGE_DOCKER_ARCH==="amd64"?"amd64":"arm64",abi:"glibc",runtimes:{node:22}},seccompProfile:process.env.STATION_IMAGE_DOCKER_SECCOMP,maxRuntimeMs:15_000}}}}}),root);
  stations.push(station);const key=await station.keyStore!.create("worker operator",["admin","read","trigger","cancel"]);await station.start();const url=`http://127.0.0.1:${port}`;
  const env=await fetch(`${url}/api/v1/env`,{method:"POST",headers:{authorization:`Bearer ${key.key}`,"content-type":"application/json"},body:JSON.stringify({key:"IMAGE_TOKEN",value:`approved-${tenantId}`,secret:true})});assert.equal(env.status,201);
  namespaces[tenantId]={registry:source,execution:createTenantRegistryWorkerGateway({tenantId,registry:source,url,token:key.key,stationId:workerId})};workers.set(tenantId,{url,key:key.key,queue});
 }
 const keyStorage=new MemoryKeyStorage(),keys=new KeyStore(keyStorage),a=await keys.create("tenant-a",["registry"]),b=await keys.create("tenant-b",["registry"]),hqPort=await freePort();
 const tenants:TenantImageRegistryConfig={namespaces,apiKeys:{[a.record.id]:{tenantId:"a",permissions:["read","publish","activate","invoke"]},[b.record.id]:{tenantId:"b",permissions:["read","publish","activate","invoke"]}}};
 const hq=await createStation(resolveConfig({role:"headquarters",host:"127.0.0.1",port:hqPort,stationDir:"hq",runRunners:false,auth:{username:"operator",password:"fixture-hq-only",keyStorage},network:{stationId:"hq",adapter:new StationNetworkMemoryAdapter()},registry:{tenants}}),root);stations.push(hq);await hq.start();
 const base=`http://127.0.0.1:${hqPort}/api/v1/tenant/registry`;
 async function request(key:string,path:string,method="GET",body?:unknown,expected=200){const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},...(body===undefined?{}:{body:Buffer.isBuffer(body)?new Uint8Array(body):JSON.stringify(body)})});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result.data;}
 const published=new Map<string,string>();
 for(const [tenant,key] of [["a",a.key],["b",b.key]]){
  const code=Buffer.from(`import{readFileSync}from'node:fs';import{createInterface}from'node:readline';const send=value=>console.log(JSON.stringify({protocol:'station.process/v1',...value}));let heartbeat;for await(const line of createInterface({input:process.stdin})){const frame=JSON.parse(line);if(frame.type==='beacon:init'){send({type:'beacon:started'});send({type:'beacon:ready'});heartbeat=setInterval(()=>send({type:'beacon:heartbeat'}),100);continue;}if(frame.type==='beacon:stop'){clearInterval(heartbeat);send({type:'beacon:stopped'});break;}if(frame.export==='workflow'){send({type:'result',output:{nodes:[{name:'step',signalName:'echo',dependsOn:[],input:{kind:'ref',path:['input']}}]}});break;}if(frame.input?.delayMs)await new Promise(resolve=>setTimeout(resolve,frame.input.delayMs));send({type:'result',output:{tenant:${JSON.stringify(tenant)},input:frame.input,token:process.env.IMAGE_TOKEN,hostOnly:process.env.IMAGE_HOST_ONLY??null,uid:process.getuid(),seccomp:readFileSync('/proc/self/status','utf8').match(/^Seccomp:\\s*(.*)$/m)[1].trim()}});break;}`);
  const digest=digestBytes(code);await request(key,`/blobs/${digest}`,"PUT",code,201);
  const manifest:ImageManifest={format:"station.image/v1",protocol:"station.process/v1",name:"customer/app",version:"1.0.0",artifacts:[{digest,size:code.length,entrypoint:"index.mjs",runtime:"node",runtimeMajor:22,platform:{os:"any",arch:"any"}}],exports:[{name:"echo",kind:"signal",requiredEnv:["IMAGE_TOKEN"],inputSchema:{type:"object"}},{name:"workflow",kind:"broadcast",planner:"binary",inputSchema:{type:"object"}},{name:"watch",kind:"beacon",mode:"run",startMode:"on-demand",configSchema:{type:"object"}}]};
  const record=await request(key,"/images","POST",manifest,201);published.set(tenant,record.digest);
  await request(key,"/install","POST",{reference:record.digest},201);
  const run=await request(key,"/run","POST",{reference:record.digest,export:"echo",input:{owner:tenant}},201);
  const inspect=(kind:string,id:string,exportName:string)=>request(key,`/runs/${kind}/${id}?reference=${record.digest}&export=${exportName}`);
  const completed=await waitFor(async()=>{const value=await inspect("signal",run.id,"echo");return ["completed","failed"].includes(value.status)?value:undefined},`${tenant} container run`);
  assert.equal(completed.status,"completed",completed.error);assert.equal(completed.stationId,`worker-${tenant}`);assert.equal(completed.requiredStationId,`worker-${tenant}`);
  assert.deepEqual(JSON.parse(completed.output!),{tenant,input:{owner:tenant},token:`approved-${tenant}`,hostOnly:null,uid:1000,seccomp:"2"});
  const workflow=await request(key,"/run","POST",{reference:record.digest,export:"workflow",input:{owner:tenant}},201);
  const finished=await waitFor(async()=>{const value=await inspect("broadcast",workflow.id,"workflow");return ["completed","failed"].includes(value.status)?value:undefined},`${tenant} broadcast completion`);assert.equal(finished.status,"completed",finished.error);
  const nodeRuns=await workers.get(tenant)!.queue.listRuns(run.registeredName);assert.ok(nodeRuns.some(value=>value.status==="completed"&&value.id!==run.id&&JSON.parse(value.input).owner===tenant));
  for(const [kind,exportName] of [["signal","echo"],["broadcast","workflow"]]){
   const pending=await request(key,"/run","POST",{reference:record.digest,export:exportName,input:{delayMs:10_000}},201);
   await waitFor(async()=>{const value=await inspect(kind,pending.id,exportName);return value.status==="running"?value:undefined},`${kind} running`);
   await request(key,`/runs/${kind}/${pending.id}/cancel`,"POST",{reference:record.digest,export:exportName});
   await waitFor(async()=>{const value=await inspect(kind,pending.id,exportName);return value.status==="cancelled"?value:undefined},`${kind} cancellation`);
  }
  const beacon=await request(key,"/run","POST",{reference:record.digest,export:"watch",input:{}},201);
  const ready=await waitFor(async()=>{const value=await inspect("beacon",beacon.id,"watch");return value.readyAt?value:undefined},`${tenant} beacon ready`);
  await request(key,`/runs/beacon/${beacon.id}/restart`,"POST",{reference:record.digest,export:"watch"});
  await waitFor(async()=>{const value=await inspect("beacon",beacon.id,"watch");return value.readyAt&&value.incarnation>ready.incarnation?value:undefined},`${tenant} beacon restarted`);
  await request(key,`/runs/beacon/${beacon.id}/cancel`,"POST",{reference:record.digest,export:"watch"});
  await waitFor(async()=>{const value=await inspect("beacon",beacon.id,"watch");return value.status==="stopped"?value:undefined},`${tenant} beacon stopped`);
  await request(tenant==="a"?b.key:a.key,`/runs/signal/${run.id}?reference=${record.digest}&export=echo`,"GET",undefined,404);

 }
 await request(a.key,`/resolve?ref=${published.get("b")}`,"GET",undefined,404);
 await request(a.key,"/run","POST",{reference:published.get("b"),export:"echo",input:{}},404);
 await request(a.key,"/run","POST",{reference:published.get("a"),export:"echo",input:{},stationId:"worker-b"},400);
 const wrongTarget=await fetch(`${workers.get("a")!.url}/api/v1/registry/run`,{method:"POST",headers:{authorization:`Bearer ${workers.get("a")!.key}`,"content-type":"application/json","x-station-image-tenant":"b","x-station-image-worker":"worker-a"},body:JSON.stringify({reference:published.get("a"),export:"echo",input:{}})});assert.equal(wrongTarget.status,409);
 await keys.revoke(a.record.id);await request(a.key,"/images","GET",undefined,401);
});
