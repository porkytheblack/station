import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SignalRunner, MemoryAdapter } from "station-signal";
import { BroadcastRunner, BroadcastMemoryAdapter } from "station-broadcast";
import { FileImageRegistry, digestBytes, validateManifest, type ImageManifest } from "station-images";
import { prepareNativeSignal, loadNativeSignal, nativeSignalName, type NativeSignalGrant } from "../../src/images/native-signal.js";
import { ImageController } from "../../src/images/controller.js";
import { type ImageBackendConfig } from "../../src/images/runtime.js";
process.env.__STATION_TSX ??= fileURLToPath(import.meta.resolve("tsx"));
const backend:ImageBackendConfig={kind:"trusted-local",allowUnsafeHostExecution:true,target:{os:process.platform as "linux"|"darwin",arch:process.arch==="arm64"?"arm64":"amd64",abi:"none",runtimes:{node:Number(process.versions.node.split(".")[0])}}};
async function setup(t:test.TestContext){const root=await mkdtemp(join(tmpdir(),"station-native-grants-"));t.after(()=>rm(root,{recursive:true,force:true}));const code=`import {signal,z} from 'station-signal';export default signal('trusted_step').input(z.unknown()).run(async input=>({native:true,input}));`,file=join(root,"bundle.mjs");await writeFile(file,code);const grant:NativeSignalGrant={name:"trusted_step",file,revision:digestBytes(code),selfContained:true};return{root,code,grant};}
async function waitFor<T>(read:()=>Promise<T|undefined>,label:string){const end=Date.now()+12000;while(Date.now()<end){const value=await read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error(`Timed out: ${label}`);}

test("native operator bundles require exact revision/name and verify cached bytes at every bootstrap",async t=>{
 const {root,code,grant}=await setup(t),prepared=await prepareNativeSignal(grant,root);assert.equal(prepared.definition.name,nativeSignalName(grant));
 await assert.rejects(prepareNativeSignal({...grant,name:"other"},root),{code:"native_grant_denied"});
 await writeFile(grant.file,code+"\n// changed");await assert.rejects(prepareNativeSignal(grant,root),{code:"digest_mismatch"});
 await chmod(prepared.snapshot.path,0o600);await writeFile(prepared.snapshot.path,"throw new Error('must not execute');");await assert.rejects(loadNativeSignal(prepared.snapshot),{code:"digest_mismatch"});
 const bad=`import './mutable.js';${code}`;await writeFile(grant.file,bad);await assert.rejects(prepareNativeSignal({...grant,revision:digestBytes(bad)},root),/prebundled/);
});

test("compiled planner mixes image and revision-pinned native Station signals and resumes saved plan without repeating completed children",{timeout:25000},async t=>{
 const {root,grant}=await setup(t),registry=new FileImageRegistry(join(root,"registry")),queue=new MemoryAdapter(),broadcasts=new BroadcastMemoryAdapter();
 const bytes=Buffer.from(`let raw='';for await(const c of process.stdin)raw+=c;const frame=JSON.parse(raw);if(frame.export==='workflow')console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{nodes:[{name:'native',signalName:'trusted',dependsOn:[],input:{kind:'ref',path:['input']}},{name:'image',signalName:'echo',dependsOn:['native'],input:{kind:'ref',path:['upstream','native']}}]}}));else{await new Promise(r=>setTimeout(r,500));console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:{image:true,input:frame.input}}));}`);
 const blob=await registry.putBlob(bytes),manifest:ImageManifest={format:"station.image/v1",protocol:"station.process/v1",name:"mixed/workflow",version:"1.0.0",artifacts:[{...blob,entrypoint:"app.mjs",runtime:"node",runtimeMajor:20,platform:{os:"any",arch:"any"}}],exports:[{name:"workflow",kind:"broadcast",planner:"binary"},{name:"echo",kind:"signal"}],nativeSignals:{trusted:{name:grant.name,revision:grant.revision}}};
 assert.throws(()=>validateManifest({...manifest,nativeSignals:{echo:manifest.nativeSignals!.trusted}}),{code:"invalid_manifest"});
 const record=await registry.publish(manifest);let signals=new SignalRunner({adapter:queue,pollIntervalMs:10});let runner=new BroadcastRunner({signalRunner:signals,adapter:broadcasts,pollIntervalMs:10,reconcileEveryNTicks:0});
 const options={registry,signalRunner:signals,stateDir:join(root,"runtime"),backend,nativeSignals:[grant]};
 const denied=new ImageController({...options,nativeSignals:[],stateDir:join(root,"denied"),broadcastRunner:runner});await assert.rejects(denied.install(record.digest),{code:"native_grant_denied"});
 let controller=new ImageController({...options,broadcastRunner:runner});await controller.install(record.digest);
 let signalLoop=signals.start(),loop=runner.start();
 try{
  const job=await controller.run(record.digest,"workflow",{hello:"mixed"});
  await waitFor(async()=>{const nodes=await broadcasts.getNodeRuns(job.id);return nodes.some(n=>n.nodeName==="native"&&n.status==="completed")?nodes:undefined},"native child completed");
  await runner.stop();await loop;const snapshot=(await broadcasts.getBroadcastRun(job.id))!.definitionSnapshot;
  assert.equal(JSON.parse(snapshot!).nodes[0].signalName,nativeSignalName(grant));
  await signals.stop({graceful:true});await signalLoop;signals=new SignalRunner({adapter:queue,pollIntervalMs:10});
  runner=new BroadcastRunner({signalRunner:signals,adapter:broadcasts,pollIntervalMs:10,reconcileEveryNTicks:0});
  // The queue and persisted plan remain while a fresh controller restores definitions.
  controller=new ImageController({...options,signalRunner:signals,broadcastRunner:runner});await controller.restore();signalLoop=signals.start();loop=runner.start();
  const completed=await waitFor(async()=>{const run=await broadcasts.getBroadcastRun(job.id);return run&&["completed","failed"].includes(run.status)?run:undefined},"recovered mixed workflow");assert.equal(completed.status,"completed",completed.error);
  assert.equal(completed.definitionSnapshot,snapshot);const nativeRuns=await queue.listRuns(nativeSignalName(grant));assert.equal(nativeRuns.length,1);assert.equal(nativeRuns[0]!.status,"completed");
  const nodes=await broadcasts.getNodeRuns(job.id),last=nodes.find(n=>n.nodeName==="image")!,imageRun=await queue.getRun(last.signalRunId!);assert.deepEqual(JSON.parse(imageRun!.output!),{image:true,input:{native:true,input:{hello:"mixed"}}});
 }finally{await runner.stop();await loop;await signals.stop({graceful:true});await signalLoop;}
});
