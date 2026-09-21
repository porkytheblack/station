import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { FileImageRegistry, ImageRegistry, MemoryRegistryBlobAdapter, MemoryRegistryMetadataAdapter, digestBytes, ImageUploadManager, FileImageUploadStorage, MemoryImageUploadStorage, type ImageUploadStorage } from "../src/index.js";
const memoryRegistry = (id = "fixture") => new ImageRegistry({ maxBlobBytes: 1024, storage: { id, metadata: new MemoryRegistryMetadataAdapter(), blobs: new MemoryRegistryBlobAdapter() } });

test("file uploads resume after a killed client, commit idempotently, and retain the final immutable blob after cancel", async t => {
  const root = await mkdtemp(join(tmpdir(), "station-resume-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("hello world"), digest = digestBytes(bytes);
  const fixture = join(root, "client.mjs");
  await writeFile(fixture, `import {FileImageRegistry,FileImageUploadStorage,ImageUploadManager,digestBytes} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}; const registry=new FileImageRegistry(${JSON.stringify(join(root,"registry"))}); const manager=new ImageUploadManager({registry,storage:new FileImageUploadStorage(${JSON.stringify(join(root,"stage"))})}); const upload=await manager.create(${JSON.stringify(digest)},11); await manager.append(upload.id,0,Buffer.from('hello'),digestBytes('hello')); process.stdout.write(upload.id+'\\n');setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, ["--import", "tsx", fixture], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const id = await new Promise<string>((resolve, reject) => { let output = "", stderr = ""; child.stderr.on("data", data => stderr += data); child.stdout.on("data", data => { output += data; if (output.includes("\n")) resolve(output.trim()); }); child.once("error", reject); child.once("exit", code => reject(new Error(`fixture exited ${code}: ${stderr}`))); });
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const registry = new FileImageRegistry(join(root, "registry"));
  const manager = new ImageUploadManager({ registry, storage: new FileImageUploadStorage(join(root, "stage")) });
  assert.equal((await manager.get(id)).offset, 5);
  await manager.append(id, 5, bytes.subarray(5), digestBytes(bytes.subarray(5)));
  assert.equal((await manager.commit(id)).state, "committed"); assert.equal((await manager.commit(id)).state, "committed");
  assert.deepEqual(await registry.getBlob(digest), bytes);
  await manager.cancel(id); await manager.cancel(id);
  await assert.rejects(manager.get(id), { code: "not_found" }); assert.deepEqual(await registry.getBlob(digest), bytes);
});

test("independent file clients serialize admission and identical chunk retries", async t => {
  const root = await mkdtemp(join(tmpdir(), "station-upload-race-")); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = memoryRegistry();
  const a = new ImageUploadManager({ registry, storage: new FileImageUploadStorage(root), maxUploads: 1 });
  const b = new ImageUploadManager({ registry, storage: new FileImageUploadStorage(root), maxUploads: 1 });
  const creates = await Promise.allSettled([a.create(digestBytes("abc"),3), b.create(digestBytes("abc"),3)]);
  assert.equal(creates.filter(result => result.status === "fulfilled").length, 1);
  const id = (creates.find(result => result.status === "fulfilled") as PromiseFulfilledResult<any>).value.id;
  const results = await Promise.all([a.append(id,0,Buffer.from("abc"),digestBytes("abc")),b.append(id,0,Buffer.from("abc"),digestBytes("abc"))]);
  assert.deepEqual(results.map(record => record.offset), [3,3]);
  await assert.rejects(a.append(id,0,Buffer.from("xyz"),digestBytes("xyz")), {code:"upload_conflict"});
  await b.commit(id); assert.equal((await registry.getBlob(digestBytes("abc"))).toString(), "abc");
});

test("chunks enforce offsets, digests, declared size, staging corruption and incomplete commit", async t => {
  const root = await mkdtemp(join(tmpdir(), "station-upload-invalid-")); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = memoryRegistry(); const manager = new ImageUploadManager({registry,storage:new FileImageUploadStorage(root),maxChunkBytes:3});
  const record=await manager.create(digestBytes("abc"),3);
  await assert.rejects(manager.append(record.id,0,Buffer.from("abc"),digestBytes("bad")),{code:"digest_mismatch"});
  await assert.rejects(manager.append(record.id,0,Buffer.from("abcd"),digestBytes("abcd")),{code:"chunk_too_large"});
  await assert.rejects(manager.append(record.id,1,Buffer.from("a"),digestBytes("a")),{code:"upload_conflict"});
  await assert.rejects(manager.commit(record.id),{code:"upload_incomplete"});
  assert.equal((await manager.get(record.id)).offset,0);
  await manager.append(record.id,0,Buffer.from("abc"),digestBytes("abc"));
  await writeFile(join(root,record.id,"chunk-0"),"bad");
  await assert.rejects(manager.commit(record.id),{code:"digest_mismatch"});
  await assert.rejects(registry.getBlob(record.digest),{code:"not_found"});
  await assert.rejects(manager.get("../escape"),{code:"invalid_upload"});
  const mismatch=await manager.create(digestBytes("wrong final digest"),3);
  await manager.append(mismatch.id,0,Buffer.from("abc"),digestBytes("abc"));
  await assert.rejects(manager.commit(mismatch.id),{code:"digest_mismatch"});
});

test("fixed expiry, quota reservations and namespace binding cannot be bypassed", async () => {
  let now=1000; const storage=new MemoryImageUploadStorage(),registry=memoryRegistry();
  const manager=new ImageUploadManager({registry,storage,maxStagedBytes:3,ttlMs:1000,now:()=>now});
  const record=await manager.create(digestBytes("abc"),3);
  await assert.rejects(manager.create(digestBytes("a"),1),{code:"upload_quota"});
  await manager.append(record.id,0,Buffer.from("abc"),digestBytes("abc")); await manager.commit(record.id);
  await assert.rejects(manager.create(digestBytes("a"),1),{code:"upload_quota"});
  const foreign=new ImageUploadManager({registry:memoryRegistry("other"),storage});
  await assert.rejects(foreign.cancel(record.id),{code:"corrupt_upload"});
  now=2000; await assert.rejects(manager.get(record.id),{code:"upload_expired"});
  assert.equal(await manager.sweep(),1); assert.equal(await manager.sweep(),0);
  assert.equal((await manager.create(digestBytes("a"),1)).offset,0);
});

test("interrupted metadata writes recover staged chunks and final blob creation without duplication", async () => {
  const underlying=new MemoryImageUploadStorage(),registry=memoryRegistry(); let fault:"append"|"commit"|undefined;
  const storage:ImageUploadStorage={transaction: operation => underlying.transaction(tx=>operation({...tx,write:async record=>{
    if ((fault==="append"&&record.offset>0)||(fault==="commit"&&record.state==="committed")) {fault=undefined;throw new Error("interrupted metadata write");}
    await tx.write(record);
  }}))};
  const manager=new ImageUploadManager({registry,storage});const record=await manager.create(digestBytes("abc"),3);
  fault="append";await assert.rejects(manager.append(record.id,0,Buffer.from("abc"),digestBytes("abc")),/interrupted/);
  assert.equal((await manager.get(record.id)).offset,0);
  await manager.append(record.id,0,Buffer.from("abc"),digestBytes("abc"));
  fault="commit";await assert.rejects(manager.commit(record.id),/interrupted/);
  assert.equal((await registry.getBlob(record.digest)).toString(),"abc");
  assert.equal((await manager.commit(record.id)).state,"committed");
});
