import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ImageRegistry, MemoryRegistryMetadataAdapter, MemoryRegistryBlobAdapter, ImageUploadManager, MemoryImageUploadStorage, digestBytes, type ImageManifest } from "station-images";
import { KeyStore, MemoryKeyStorage } from "../../../src/server/auth/keys.js";
import { authResolver } from "../../../src/server/middleware/auth.js";
import { tenantImageRegistryRoutes } from "../../../src/server/routes/v1/tenant-registry.js";
import { RegistryTenantAccess, type TenantImageRegistryConfig } from "../../../src/registry/tenants.js";
const registry=(id:string)=>new ImageRegistry({maxBlobBytes:1024,storage:{id,metadata:new MemoryRegistryMetadataAdapter(),blobs:new MemoryRegistryBlobAdapter()}});
async function publish(target:ImageRegistry,text:string){const bytes=Buffer.from(text),digest=digestBytes(bytes);await target.putBlob(bytes,digest);const manifest:ImageManifest={format:"station.image/v1",protocol:"station.process/v1",name:"private/echo",version:"1.0.0",exports:[{name:"echo",kind:"signal",inputSchema:{type:"object",properties:{value:{type:"string"}},additionalProperties:false}}],artifacts:[{platform:{os:"any",arch:"any"},runtime:"node",runtimeMajor:22,digest,size:bytes.length,entrypoint:"echo.mjs"}]};return target.publish(manifest);}

test("tenant registry namespaces prevent digest, blob, tag, catalog and staging leaks using real verified keys",async()=>{
  const keys=new KeyStore(new MemoryKeyStorage());const a=await keys.create("a",["registry"]),b=await keys.create("b",["registry"]),read=await keys.create("reader",["registry"]),publisher=await keys.create("publisher",["registry"]),wrong=await keys.create("legacy",["read"]),mixed=await keys.create("mixed",["registry","admin"]),unmapped=await keys.create("unmapped",["registry"]);
  const ra=registry("a"),rb=registry("b"),ia=await publish(ra,"tenant a artifact"),ib=await publish(rb,"tenant b artifact");
  const ua=new ImageUploadManager({registry:ra,storage:new MemoryImageUploadStorage()}),ub=new ImageUploadManager({registry:rb,storage:new MemoryImageUploadStorage()});
  const config:TenantImageRegistryConfig={namespaces:{a:{registry:ra,uploads:ua},b:{registry:rb,uploads:ub}},apiKeys:{[a.record.id]:{tenantId:"a",permissions:["read","publish","activate","invoke"]},[b.record.id]:{tenantId:"b",permissions:["read","publish"]},[read.record.id]:{tenantId:"a",permissions:["read"]},[publisher.record.id]:{tenantId:"a",permissions:["publish"]},[wrong.record.id]:{tenantId:"a",permissions:["read"]},[mixed.record.id]:{tenantId:"a",permissions:["read"]}},limits:{burst:1000}};
  const app=new Hono();app.use("*",authResolver({keyStore:keys}));app.route("/",tenantImageRegistryRoutes(config));
  const request=(key:string,path:string,method="GET",body?:unknown,extra:Record<string,string>={})=>app.request(`/tenant/registry${path}`,{method,headers:{authorization:`Bearer ${key}`,"content-type":"application/json",...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await request("","/images")).status,401);
  for(const key of [wrong.key,mixed.key,unmapped.key])assert.equal((await request(key,"/images")).status,403);
  const listed=await request(a.key,"/images");assert.equal(listed.headers.get("cache-control"),"private, no-store");assert.deepEqual((await listed.json()).data,[ia]);
  const own=await request(a.key,"/resolve?ref=private%2Fecho%401.0.0&tenantId=b","GET",undefined,{"x-station-execution-tenant":"b"});assert.equal((await own.json()).data.digest,ia.digest);
  assert.equal((await request(a.key,`/resolve?ref=${ib.digest}`)).status,404);
  assert.equal((await request(a.key,`/blobs/${ib.manifest.artifacts[0]!.digest}`)).status,404);
  assert.equal((await request(a.key,"/tags","PUT",{name:"private/echo",tag:"foreign",digest:ib.digest})).status,404);
  assert.equal((await request(b.key,`/resolve?ref=${ia.digest}`)).status,404);
  const foreignDependency={...ia.manifest,version:"2.0.0",dependencies:{other:{image:`private/echo@${ib.digest}`,export:"echo",kind:"signal"}}};assert.equal((await request(a.key,"/images","POST",foreignDependency)).status,404);
  assert.equal((await request(read.key,"/images","POST",ia.manifest)).status,403);
  assert.equal((await request(publisher.key,"/images")).status,403);
  assert.equal((await request(a.key,"/install","POST",{reference:ia.digest})).status,409);
  assert.equal((await request(a.key,"/run","POST",{reference:ia.digest,export:"echo"})).status,409);
  const created=await request(a.key,"/uploads","POST",{digest:digestBytes("abc"),size:3});assert.equal(created.status,201);const {data:upload}=await created.json();
  assert.equal((await request(b.key,`/uploads/${upload.id}`)).status,404);
  assert.equal((await request(b.key,`/uploads/${upload.id}/commit`,"POST")).status,404);
  assert.equal((await request(b.key,`/uploads/${upload.id}`,"DELETE")).status,204);assert.equal((await ua.get(upload.id)).offset,0);
  const changed=await request(a.key,"/uploads","POST",{digest:digestBytes("abc"),size:3,tenantId:"b"});assert.equal(changed.status,400);
  await keys.revoke(a.record.id);assert.equal((await request(a.key,"/images")).status,401);
});

test("activate and invoke grants use only a fixed dedicated gateway and pinned local references",async()=>{
  const keys=new KeyStore(new MemoryKeyStorage()),activate=await keys.create("activate",["registry"]),invoke=await keys.create("invoke",["registry"]);
  const r=registry("tenant-a"),image=await publish(r,"owned code");await r.setTag("private/echo","latest",image.digest);const calls:unknown[]=[];
  const config:TenantImageRegistryConfig={namespaces:{a:{registry:r,execution:{tenantId:"a",registryIdentity:r.identity,dedicated:true,isolation:"container",install:async reference=>{calls.push(["install",reference]);return {installed:reference};},run:async(reference,name,input)=>{calls.push(["run",reference,name,input]);return {queued:true};}}}},apiKeys:{[activate.record.id]:{tenantId:"a",permissions:["activate"]},[invoke.record.id]:{tenantId:"a",permissions:["invoke"]}}};
  const app=new Hono();app.use("*",authResolver({keyStore:keys}));app.route("/",tenantImageRegistryRoutes(config));
  const request=(key:string,path:string,body:unknown)=>app.request(`/tenant/registry/${path}`,{method:"POST",headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await request(invoke.key,"install",{reference:"private/echo@latest"})).status,403);
  assert.equal((await request(activate.key,"run",{reference:image.digest,export:"echo"})).status,403);
  assert.equal((await request(activate.key,"install",{reference:"private/echo@latest"})).status,201);
  assert.equal((await request(invoke.key,"run",{reference:"private/echo@latest",export:"echo",input:{value:"hi"}})).status,201);
  assert.equal((await request(invoke.key,"run",{reference:image.digest,export:"echo",stationId:"other"})).status,400);
  assert.equal((await request(invoke.key,"run",{reference:image.digest,export:"echo",input:{value:9}})).status,400);
  assert.deepEqual(calls,[["install",image.digest],["run",image.digest,"echo",{value:"hi"}]]);
});

test("tenant configuration rejects shared registries, foreign staging and unsafe execution bindings",()=>{
  const a=registry("a"),b=registry("b");
  assert.throws(()=>new RegistryTenantAccess({namespaces:{a:{registry:a},b:{registry:a}},apiKeys:{}}),/distinct/);
  assert.throws(()=>new RegistryTenantAccess({namespaces:{a:{registry:a}},apiKeys:{}},["a"]),/distinct/);
  assert.throws(()=>new RegistryTenantAccess({namespaces:{a:{registry:a,uploads:new ImageUploadManager({registry:b,storage:new MemoryImageUploadStorage()})}},apiKeys:{}}),/own registry/);
  const unsafe={tenantId:"b",registryIdentity:a.identity,dedicated:true,isolation:"container",install:async()=>({}),run:async()=>({})};
  assert.throws(()=>new RegistryTenantAccess({namespaces:{a:{registry:a,execution:unsafe as any}},apiKeys:{}}),/dedicated isolated/);
  assert.throws(()=>new RegistryTenantAccess({namespaces:{a:{registry:a}},apiKeys:{key:{tenantId:"b",permissions:["read"]}}}),/grant/);
});

test("tenant lifecycle routes separate read from invoke and reject caller-selected worker parameters",async()=>{
 const keys=new KeyStore(new MemoryKeyStorage()),read=await keys.create("read",["registry"]),invoke=await keys.create("invoke",["registry"]);
 const r=registry("lifecycle"),image=await publish(r,"owned code"),calls:unknown[]=[];
 const execution={tenantId:"a",registryIdentity:r.identity,dedicated:true as const,isolation:"container" as const,install:async()=>({}),run:async()=>({}),inspect:async(target:unknown)=>{calls.push(["inspect",target]);return{status:"completed"}},cancel:async(target:unknown)=>{calls.push(["cancel",target]);return{cancelled:true}},restart:async(target:unknown)=>{calls.push(["restart",target]);return{restarted:true}}};
 const app=new Hono();app.use("*",authResolver({keyStore:keys}));app.route("/",tenantImageRegistryRoutes({namespaces:{a:{registry:r,execution}},apiKeys:{[read.record.id]:{tenantId:"a",permissions:["read"]},[invoke.record.id]:{tenantId:"a",permissions:["invoke"]}}}));
 const query=`?reference=${image.digest}&export=echo`,body={reference:image.digest,export:"echo"};
 const request=(key:string,path:string,method="GET",value?:unknown)=>app.request(`/tenant/registry/runs/${path}`,{method,headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},...(value===undefined?{}:{body:JSON.stringify(value)})});
 assert.equal((await request(read.key,"signal/owned"+query)).status,200);
 assert.equal((await request(invoke.key,"signal/owned"+query)).status,403);
 assert.equal((await request(read.key,"signal/owned/cancel","POST",body)).status,403);
 assert.equal((await request(invoke.key,"signal/owned/cancel","POST",body)).status,200);
 assert.equal((await request(invoke.key,"signal/owned/restart","POST",body)).status,400);
 assert.equal((await request(invoke.key,"beacon/owned/restart","POST",body)).status,200);
 assert.equal((await request(invoke.key,"signal/owned/cancel","POST",{...body,stationId:"foreign"})).status,400);
 assert.equal((await request(read.key,"signal/owned"+query+"&tenantId=foreign")).status,400);
 assert.deepEqual(calls.map(call=>(call as any[])[0]),["inspect","cancel","restart"]);
 await keys.revoke(read.record.id);assert.equal((await request(read.key,"signal/owned"+query)).status,401);
});
