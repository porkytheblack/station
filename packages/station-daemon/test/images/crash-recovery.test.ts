import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from 'station-adapter-sqlite';
import { BroadcastSqliteAdapter } from 'station-adapter-sqlite/broadcast';
import { StationNetworkSqliteAdapter } from 'station-adapter-sqlite/network';
import { FileImageRegistry,digestBytes } from 'station-images';
import { ImagePreparations } from '../../src/images/preparation.js';
import { nativeSignalName } from '../../src/images/native-signal.js';
const fixture=fileURLToPath(new URL('./fixtures/crash-worker.ts',import.meta.url));
const backend={kind:'trusted-local',allowUnsafeHostExecution:true,target:{os:process.platform,arch:process.arch==='arm64'?'arm64':'amd64',abi:'none',runtimes:{node:Number(process.versions.node.split('.')[0])}}};
async function child(t:test.TestContext,root:string,config:unknown){const path=join(root,`worker-${Math.random()}.json`);await writeFile(path,JSON.stringify(config));const process=fork(fixture,[path],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});let error='';process.stderr!.on('data',bytes=>{error+=bytes.toString()});const messages:any[]=[];process.on('message',message=>messages.push(message));t.after(()=>{if(process.exitCode===null&&process.signalCode===null)process.kill('SIGKILL')});return{process,messages,error:()=>error};}
async function message(worker:Awaited<ReturnType<typeof child>>,type:string){const deadline=Date.now()+15000;while(Date.now()<deadline){const value=worker.messages.find(item=>item.type===type);if(value)return value;if(worker.process.exitCode!==null)throw Error(`Worker exited: ${worker.error()}`);await new Promise(resolve=>setTimeout(resolve,15));}throw Error(`Timed out ${type}: ${worker.error()}`);}
async function kill(process:ChildProcess){const exited=once(process,'exit');process.kill('SIGKILL');await exited;}

test('SIGKILL during a persisted compiled plan resumes in a fresh process without repeating its completed native child',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'station-plan-crash-'));t.after(()=>rm(root,{recursive:true,force:true}));const registry=new FileImageRegistry(join(root,'registry'));
 const code=`import{signal,z}from'station-signal';export default signal('trusted_child').input(z.unknown()).run(async input=>({native:true,input}));`,file=join(root,'trusted.mjs');await writeFile(file,code);const grant={name:'trusted_child',file,revision:digestBytes(code),selfContained:true as const};
 const bytes=Buffer.from(`let text='';for await(const c of process.stdin)text+=c;const f=JSON.parse(text);console.log(JSON.stringify({protocol:'station.process/v1',type:'result',output:f.export==='workflow'?{nodes:[{name:'native',signalName:'trusted',dependsOn:[],input:{kind:'ref',path:['input']}},{name:'image',signalName:'echo',dependsOn:['native'],input:{kind:'ref',path:['upstream','native']}}]}:{image:true,input:f.input}}));`),blob=await registry.putBlob(bytes);
 const image=await registry.publish({format:'station.image/v1',protocol:'station.process/v1',name:'crash/plan',version:'1.0.0',artifacts:[{...blob,entrypoint:'app.mjs',runtime:'node',runtimeMajor:20,platform:{os:'any',arch:'any'}}],exports:[{name:'workflow',kind:'broadcast',planner:'binary'},{name:'echo',kind:'signal'}],nativeSignals:{trusted:{name:grant.name,revision:grant.revision}}});
 const config={mode:'plan',root,digest:image.digest,grants:[grant],backend};const first=await child(t,root,{...config,pause:true});const runId=(await message(first,'run')).id;await message(first,'checkpoint');await kill(first.process);
 const broadcasts=new BroadcastSqliteAdapter({dbPath:join(root,'broadcasts.db')}),queue=new SqliteAdapter({dbPath:join(root,'signals.db')});t.after(async()=>{await broadcasts.close();await queue.close()});const saved=(await broadcasts.getBroadcastRun(runId))!.definitionSnapshot;assert.equal((await broadcasts.getNodeRuns(runId)).filter(n=>n.status==='completed').length,1);
 const second=await child(t,root,{...config,pause:false,runId});const finished=await message(second,'finished');assert.equal(finished.run.status,'completed',finished.run.error);assert.equal(finished.run.definitionSnapshot,saved);assert.equal((await queue.listRuns(nativeSignalName(grant))).length,1);assert.ok(finished.nodes.every((node:any)=>node.status==='completed'));
 const imageNode=finished.nodes.find((node:any)=>node.nodeName==='image'),result=await queue.getRun(imageNode.signalRunId);assert.deepEqual(JSON.parse(result!.output!),{image:true,input:{native:true,input:{hello:'crash'}}});
});

test('SIGKILL leaves preparation reservation fenced until expiry, then a fresh worker can acquire it',{timeout:15000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'station-preparation-crash-'));t.after(()=>rm(root,{recursive:true,force:true}));const first=await child(t,root,{mode:'preparation',root});await message(first,'reserved');await kill(first.process);
 const adapter=new StationNetworkSqliteAdapter({dbPath:join(root,'network.db')}),replacement=new ImagePreparations({adapter,networkId:'crash-test',stationId:'replacement',timeoutMs:1000});t.after(async()=>{await replacement.stop();await adapter.close?.()});let calls=0;
 const run={id:'reserved-run',signalName:'reserved-image'};await replacement.request(run,async()=>{calls++});assert.equal(calls,0);assert.deepEqual(replacement.list(),[]);
 await new Promise(resolve=>setTimeout(resolve,6200));await replacement.request(run,async owned=>{assert.equal(await owned(),true);calls++});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);assert.equal(replacement.list()[0]!.state,'ready');
});
