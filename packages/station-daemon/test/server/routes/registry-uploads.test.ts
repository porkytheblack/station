import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { ImageRegistry, MemoryRegistryBlobAdapter, MemoryRegistryMetadataAdapter, MemoryImageUploadStorage, ImageUploadManager, digestBytes } from "station-images";
import { imageUploadRoutes } from "../../../src/server/routes/v1/registry-uploads.js";

test("resumable HTTP upload protocol authenticates every operation and verifies streamed chunks", async () => {
  const registry = new ImageRegistry({maxBlobBytes:1024, storage:{id:"test",metadata:new MemoryRegistryMetadataAdapter(),blobs:new MemoryRegistryBlobAdapter()}});
  const uploads = new ImageUploadManager({registry,storage:new MemoryImageUploadStorage(),maxChunkBytes:128});
  const app = new Hono();
  app.use("*", async (c,next)=>{c.set("authType",c.req.header("x-test-scope")?"api-key":"none");c.set("scopes",[c.req.header("x-test-scope")]);await next();});
  app.route("/",imageUploadRoutes(uploads));
  const admin={"x-test-scope":"admin","content-type":"application/json"};
  const digest=digestBytes("hello world");
  const created=await app.request("/registry/uploads",{method:"POST",headers:admin,body:JSON.stringify({digest,size:11})});
  assert.equal(created.status,201);assert.equal(created.headers.get("cache-control"),"private, no-store");
  const {data:{id}}=await created.json();
  for(const scope of ["","read","trigger","execution"]){for(const [method,path] of [["POST","/registry/uploads"],["GET",`/registry/uploads/${id}`],["PATCH",`/registry/uploads/${id}`],["POST",`/registry/uploads/${id}/commit`],["DELETE",`/registry/uploads/${id}`]]){
    const response=await app.request(path,{method,headers:{"x-test-scope":scope},...(method==="GET"||method==="DELETE"?{}:{body:"{}"})});assert.equal(response.status,scope?403:401,`${scope}:${method}`);
  }}
  assert.equal((await app.request(`/registry/uploads/${id}/commit`,{method:"POST",headers:admin})).status,409);
  const append=(offset:string,chunk:string,digest=digestBytes(chunk))=>app.request(`/registry/uploads/${id}`,{method:"PATCH",headers:{...admin,"upload-offset":offset,"x-chunk-sha256":digest},body:chunk});
  assert.equal((await append("0","hello")).status,200);
  assert.equal((await append("0","hello")).headers.get("upload-offset"),"5");
  assert.equal((await append("0","world")).status,409);
  assert.equal((await append("5"," world",digestBytes("bad"))).status,400);
  assert.equal((await append("5","x".repeat(129))).status,413);
  assert.equal((await append("05"," world")).status,400);
  const resumed=await app.request(`/registry/uploads/${id}`,{headers:admin});assert.equal((await resumed.json()).data.offset,5);
  assert.equal((await append("5"," world")).status,200);
  for(let i=0;i<2;i++)assert.equal((await app.request(`/registry/uploads/${id}/commit`,{method:"POST",headers:admin})).status,200);
  assert.equal((await registry.getBlob(digest)).toString(),"hello world");
  for(let i=0;i<2;i++)assert.equal((await app.request(`/registry/uploads/${id}`,{method:"DELETE",headers:admin})).status,204);
  assert.equal((await app.request(`/registry/uploads/${id}`,{headers:admin})).status,404);
});
