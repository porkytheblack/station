import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { ImageRegistry, MemoryRegistryBlobAdapter, MemoryRegistryMetadataAdapter, ImageUploadManager, MemoryImageUploadStorage, type ImageManifest } from "station-images";
import { imageSignalName } from "../../../src/images/runtime.js";
import { createTenantRegistryWorkerGateway } from "../../../src/registry/worker-gateway.js";
import { imageRegistryRoutes } from "../../../src/server/routes/v1/registry.js";
import { imageUploadRoutes } from "../../../src/server/routes/v1/registry-uploads.js";
const registry=(id:string)=>new ImageRegistry({maxBlobBytes:1024,storage:{id,metadata:new MemoryRegistryMetadataAdapter(),blobs:new MemoryRegistryBlobAdapter()}});
async function sourceImage(source:ImageRegistry){const bytes=Buffer.from("native code fixture"),artifact=await source.putBlob(bytes);const dep=await source.publish({format:"station.image/v1",protocol:"station.process/v1",name:"test/dependency",version:"1.0.0",artifacts:[{...artifact,entrypoint:"index.mjs",platform:{os:"any",arch:"any"},runtime:"node",runtimeMajor:20}],exports:[{name:"echo",kind:"signal"}]});const manifest:ImageManifest={format:"station.image/v1",protocol:"station.process/v1",name:"test/main",version:"1.0.0",artifacts:[{...artifact,entrypoint:"index.mjs",platform:{os:"any",arch:"any"},runtime:"node",runtimeMajor:20}],exports:[{name:"main",kind:"signal"},{name:"flow",kind:"broadcast",planner:"binary"},{name:"watch",kind:"beacon",mode:"run",startMode:"on-demand"}],dependencies:{echo:{image:`test/dependency@${dep.digest}`,kind:"signal",export:"echo"}}};return{image:await source.publish(manifest),dep,bytes};}
async function fixture(t:any){
 const worker=registry("worker"),uploads=new ImageUploadManager({registry:worker,storage:new MemoryImageUploadStorage(),maxChunkBytes:3});
 const state={info:{protocol:"station.api/v1",version:"3.0.0",role:"station",stationId:"worker-a",imageExecution:{tenantId:"a",isolation:"container",registryIdentity:"worker"}},mutations:[] as any[],failPatchOnce:false,redirect:false,records:new Map<string,any>()};
 const app=new Hono();app.use("*",async(c,next)=>{assert.equal(c.req.header("authorization"),"Bearer fixture-secret");assert.equal(c.req.header("x-station-image-tenant"),"a");assert.equal(c.req.header("x-station-image-worker"),"worker-a");c.set("authType","api-key");c.set("scopes",["admin"]);if(c.req.method!=="GET")state.mutations.push({path:c.req.path,method:c.req.method});await next();if(c.req.method==="PATCH"&&state.failPatchOnce){state.failPatchOnce=false;c.res=new Response("uncertain response",{status:503});}});
 app.get("/api/v1/info",c=>state.redirect?c.redirect("http://127.0.0.1:1/credentials",302):c.json({data:state.info}));
 app.post("/api/v1/registry/install",async c=>c.json({data:{installed:await c.req.json()}},201));app.post("/api/v1/registry/run",async c=>c.json({data:{run:await c.req.json()}},201));
 for(const path of ["/api/v1/runs/:id","/api/v1/broadcast-runs/:id","/api/v1/beacons/:name/instances/:id"]){app.get(path,c=>{const data=state.records.get(c.req.param("id"));return data?c.json({data}):c.json({error:"not_found"},404)});for(const action of ["cancel","stop","restart"])app.post(`${path}/${action}`,c=>c.json({data:{action,id:c.req.param("id")}}));}
 app.route("/api/v1",imageUploadRoutes(uploads));app.route("/api/v1",imageRegistryRoutes(worker));
 const server=await new Promise<ReturnType<typeof serve>>(resolve=>{const s=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0},()=>resolve(s));});t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const address=server.address();assert.ok(address&&typeof address!=="string");return{url:`http://127.0.0.1:${address.port}`,state,worker};
}
test("fixed worker gateway validates identity before mutation and rejects redirects",async t=>{
 const source=registry("source"),{image}=await sourceImage(source),{url,state}=await fixture(t);
 const gateway=createTenantRegistryWorkerGateway({tenantId:"a",registry:source,url,token:"fixture-secret",stationId:"worker-a"});
 state.info.imageExecution.tenantId="b";await assert.rejects(gateway.install(image.digest),{code:"worker_identity_mismatch"});assert.equal(state.mutations.length,0);
 state.info.imageExecution.tenantId="a";state.info.stationId="other";await assert.rejects(gateway.install(image.digest),{code:"worker_identity_mismatch"});assert.equal(state.mutations.length,0);
 state.info.stationId="worker-a";state.info.imageExecution.isolation="trusted-host";await assert.rejects(gateway.install(image.digest),{code:"worker_identity_mismatch"});assert.equal(state.mutations.length,0);
 state.info.imageExecution.isolation="container";state.redirect=true;await assert.rejects(gateway.install(image.digest),{code:"worker_unavailable"});assert.equal(state.mutations.length,0);
 for(const bad of ["http://remote.invalid","https://user:secret@example.com","https://example.com/path","file:///tmp"]){assert.throws(()=>createTenantRegistryWorkerGateway({tenantId:"a",registry:source,url:bad,token:"fixture-secret",stationId:"worker-a"}));}
});
test("worker gateway resumes an uncertain chunk, imports dependencies and pins all execution parameters",async t=>{
 const source=registry("source"),{image,dep,bytes}=await sourceImage(source),{url,state,worker}=await fixture(t);
 const gateway=createTenantRegistryWorkerGateway({tenantId:"a",registry:source,url,token:"fixture-secret",stationId:"worker-a"});
 state.failPatchOnce=true;await assert.rejects(gateway.install(image.digest),{code:"worker_unavailable"});
 const installed:any=await gateway.install(image.digest);assert.deepEqual(installed,{installed:{reference:image.digest}});
 assert.equal((await worker.getManifest(dep.digest)).digest,dep.digest);assert.equal((await worker.getManifest(image.digest)).digest,image.digest);assert.deepEqual(await worker.getBlob(image.manifest.artifacts[0]!.digest),bytes);
 const run:any=await gateway.run(image.digest,"main",{argument:"provided"});assert.deepEqual(run,{run:{reference:image.digest,export:"main",input:{argument:"provided"},stationId:"worker-a"}});
 await assert.rejects(gateway.run("test/main@latest","main",{}),{code:"invalid_digest"});
 const before=state.mutations.length;state.info.imageExecution.registryIdentity="replacement";await assert.rejects(gateway.run(image.digest,"main",{}),{code:"worker_identity_mismatch"});assert.equal(state.mutations.length,before);
});

test("gateway lifecycle verifies immutable export and worker ownership before exposing results or mutations",async t=>{
 const source=registry("source"),{image}=await sourceImage(source),{url,state}=await fixture(t);
 const gateway=createTenantRegistryWorkerGateway({tenantId:"a",registry:source,url,token:"fixture-secret",stationId:"worker-a"});
 for(const [kind,exportName] of [["signal","main"],["broadcast","flow"],["beacon","watch"]] as const){
  const id=`owned-${kind}`,target={reference:image.digest,export:exportName,kind,id},name=imageSignalName(image.digest,exportName);
  const record:any={id,[kind==="signal"?"signalName":kind==="broadcast"?"broadcastName":"beaconName"]:name,stationId:"worker-a",requiredStationId:"worker-a",output:"private result"};
  if(kind==="broadcast")record.definitionSnapshot=JSON.stringify({requiredStationId:"worker-a"});
  record.leaseToken='internal-fencing-token';record.filePath='/private/operator/process.mjs';
  state.records.set(id,record);const inspected:any=await gateway.inspect!(target);assert.equal(inspected.id,record.id);assert.equal(inspected.output,record.output);assert.equal(inspected.leaseToken,undefined);assert.equal(inspected.filePath,undefined);assert.equal(inspected.definitionSnapshot,undefined);
  assert.equal((await gateway.cancel!(target) as any).action,kind==="beacon"?"stop":"cancel");
  if(kind==="beacon")assert.equal((await gateway.restart!(target) as any).action,"restart");else await assert.rejects(gateway.restart!(target),{code:"invalid_invocation"});
  const before=state.mutations.length;record.stationId="worker-b";await assert.rejects(gateway.inspect!(target),{code:"not_found"});await assert.rejects(gateway.cancel!(target),{code:"not_found"});assert.equal(state.mutations.length,before);
  record.stationId="worker-a";record[kind==="signal"?"signalName":kind==="broadcast"?"broadcastName":"beaconName"]="other-image";await assert.rejects(gateway.inspect!(target),{code:"not_found"});
 }
 await assert.rejects(gateway.inspect!({reference:image.digest,export:"main",kind:"signal",id:"../escape"}),{code:"invalid_invocation"});
});
