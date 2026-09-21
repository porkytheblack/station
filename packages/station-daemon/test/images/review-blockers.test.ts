import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SignalRunner } from 'station-signal';
import { BeaconMemoryAdapter } from 'station-beacon';
import { FileImageRegistry } from 'station-images';
import { ImageRuntime, imageSignalName, type ImageBackendConfig } from '../../src/images/runtime.js';
import { ImageDeployments, type DeploymentSnapshot, type ImageDeploymentStorage } from '../../src/images/deployments.js';
import { ImageController } from '../../src/images/controller.js';
const backend:ImageBackendConfig={kind:'trusted-local',allowUnsafeHostExecution:true,target:{os:process.platform as 'linux'|'darwin',arch:process.arch==='arm64'?'arm64':'amd64',abi:'none',runtimes:{node:22}}};
async function fixture(t:test.TestContext,beacon=false){const root=await mkdtemp(join(tmpdir(),'station-review-'));t.after(()=>rm(root,{recursive:true,force:true}));const registry=new FileImageRegistry(join(root,'registry')),artifact=await registry.putBlob(Buffer.from('process.exit(0)'));const image=await registry.publish({format:'station.image/v1',protocol:'station.process/v1',name:'review/test',version:'1.0.0',artifacts:[{...artifact,runtime:'node',runtimeMajor:20,entrypoint:'index.mjs',platform:{os:'any',arch:'any'}}],exports:beacon?[{name:'watch',kind:'beacon',mode:'run'}]:[{name:'echo',kind:'signal'}]});return{root,registry,image};}
class Storage implements ImageDeploymentStorage {state:DeploymentSnapshot|null=null;async read(){return structuredClone(this.state)}async compareAndSwap(expected:number,next:DeploymentSnapshot){if((this.state?.revision??0)!==expected)return false;this.state=structuredClone(next);return true}}

test('activation writer refuses unreadable oversized state before replacing a valid snapshot',async t=>{
 const {root,registry,image}=await fixture(t),stateDir=join(root,'runtime'),runtime=new ImageRuntime({registry,signalRunner:new SignalRunner(),stateDir,backend});await runtime.install(image.digest);const before=await readFile(join(stateDir,'active.json'),'utf8');
 const state=JSON.parse(before);state.generations=[{digest:image.digest,generation:{id:'00000000-0000-4000-8000-000000000000',bindings:{VALUE:{value:'x'.repeat(1024*1024)}}}}];
 await assert.rejects((runtime as any).saveState(state),{code:'activation_limit'});assert.equal(await readFile(join(stateDir,'active.json'),'utf8'),before);assert.equal((await new ImageRuntime({registry,signalRunner:new SignalRunner(),stateDir,backend}).restore()).length,1);
});

test('exhausting invocation generations retains identities and leaves staging, activation, rollback and drain available',async t=>{
 const {image}=await fixture(t),store=new Storage(),deployments=new ImageDeployments(store,'test');let deployment=await deployments.stage('production',image,undefined,undefined,undefined,['VALUE']);const first=deployment.generations[0]!.id;deployment=await deployments.change(deployment.id,deployment.revision,'activate',first);const ids:string[]=[];
 for(let i=0;i<128;i++){deployment=await deployments.get(deployment.id);ids.push((await deployments.invocation(deployment.id,deployment.revision,first,{VALUE:{value:String(i)}})).id);}
 deployment=await deployments.get(deployment.id);assert.equal((await deployments.invocation(deployment.id,deployment.revision,first,{VALUE:{value:'0'}})).id,ids[0]);deployment=await deployments.get(deployment.id);assert.equal(deployment.generations.length,129);await assert.rejects(deployments.invocation(deployment.id,deployment.revision,first,{VALUE:{value:'overflow'}}),{code:'deployment_limit'});
 deployment=await deployments.stage('production',image);const second=deployment.generations.at(-1)!.id;deployment=await deployments.change(deployment.id,deployment.revision,'activate',second);
 for(let i=0;i<520;i++)deployment=await deployments.change(deployment.id,deployment.revision,'activate',second);
 assert.ok(deployment.history.length<=512);deployment=await deployments.change(deployment.id,deployment.revision,'rollback',first);assert.equal(deployment.activeGeneration,first);deployment=await deployments.change(deployment.id,deployment.revision,'drain');assert.equal(deployment.activeGeneration,undefined);assert.ok(ids.every(id=>deployment.generations.some(g=>g.id===id)));
});

test('deleted rollout source is retained as an individual failure and does not block other deployments',async t=>{
 const {root,registry,image}=await fixture(t,true),adapter=new BeaconMemoryAdapter(),controller=new ImageController({registry,backend,signalRunner:new SignalRunner(),beaconAdapter:adapter,stateDir:join(root,'runtime')});
 for(const [index,name] of ['missing','healthy'].entries()){
  let deployment=await controller.stageDeployment(name,image.digest);const generation=deployment.generations[0]!;deployment=await controller.changeDeployment(deployment.id,deployment.revision,'activate',generation.id);const sourceName=imageSignalName(image.digest,'watch',{id:generation.id}),sourceId=`source-${index}`;
  if(index===1){const now=new Date();await adapter.upsertInstance({id:sourceId,beaconName:sourceName,origin:'api',status:'stopped',desiredState:'stopped',incarnation:1,restartCount:0,config:'{}',createdAt:now,updatedAt:now});}
  await controller.deployments.recordRollout(deployment.id,deployment.revision,{id:'operation',sourceInstance:sourceId,sourceName,targetInstance:`rollout-${String(index).repeat(64)}`,generation:generation.id,export:'watch',config:'{}',createdAt:new Date().toISOString()});
 }
 await controller.reconcileRollouts();const deployments=await controller.deployments.list(),failed=deployments.find(d=>d.name==='missing')!,healthy=deployments.find(d=>d.name==='healthy')!;assert.ok(failed.rollouts![0]!.failedAt);assert.match(failed.rollouts![0]!.error!,/missing/);assert.ok(await adapter.getInstance(healthy.rollouts![0]!.targetInstance));
 await controller.deployments.cancelRollout(healthy.id,healthy.rollouts![0]!.id,healthy.revision);assert.ok((await controller.deployments.get(healthy.id)).rollouts![0]!.cancelledAt);await controller.reconcileRollouts();
});


test('legacy 256-generation snapshots retain control operations without deleting queued invocation identities',async t=>{
 const {image}=await fixture(t),storage=new Storage(),deployments=new ImageDeployments(storage,'legacy');let deployment=await deployments.stage('legacy',image,undefined,undefined,undefined,['VALUE']);const source=deployment.generations[0]!;deployment=await deployments.change(deployment.id,deployment.revision,'activate',source.id);
 const saved=storage.state!.deployments[0]!;for(let i=0;i<255;i++)saved.generations.push({...structuredClone(source),id:`legacy-${i}`,sourceGeneration:source.id,bindings:{VALUE:{value:String(i)}}});
 deployment=await deployments.get(deployment.id);deployment=await deployments.change(deployment.id,deployment.revision,'drain');deployment=await deployments.change(deployment.id,deployment.revision,'rollback',source.id);assert.equal(deployment.generations.length,256);assert.equal(deployment.activeGeneration,source.id);
});

test('rollout cancellation route requires admin, exact request shape and current deployment revision',async t=>{
 const {Hono}=await import('hono');const {imageRegistryRoutes}=await import('../../src/server/routes/v1/registry.js');
 const {root,registry,image}=await fixture(t,true),controller=new ImageController({registry,backend,signalRunner:new SignalRunner(),stateDir:join(root,'runtime')});let deployment=await controller.stageDeployment('cancel-test',image.digest);const generation=deployment.generations[0]!;
 await controller.deployments.recordRollout(deployment.id,deployment.revision,{id:'operation',sourceInstance:'source',sourceName:'source-name',targetInstance:`rollout-${'1'.repeat(64)}`,generation:generation.id,export:'watch',config:'{}',createdAt:new Date().toISOString()});deployment=await controller.deployments.get(deployment.id);
 const app=new Hono();app.use('*',async(c,next)=>{c.set('authType','api-key');c.set('scopes',c.req.header('x-test-scope')==='admin'?['admin']:['read']);await next();});app.route('/',imageRegistryRoutes(registry,undefined,controller));
 const request=(body:unknown,scope='admin')=>app.request(`/registry/deployments/${deployment.id}/rollouts/operation/cancel`,{method:'POST',headers:{'content-type':'application/json','x-test-scope':scope},body:JSON.stringify(body)});
 assert.equal((await request({expectedRevision:deployment.revision},'read')).status,403);assert.equal((await request({expectedRevision:deployment.revision,extra:true})).status,400);assert.equal((await request({expectedRevision:deployment.revision-1})).status,409);const response=await request({expectedRevision:deployment.revision});assert.equal(response.status,200);assert.ok((await response.json() as any).data.cancelledAt);assert.equal((await controller.deployments.get(deployment.id)).revision,deployment.revision+1);
});

test('cancelling a rollout during a slow source read prevents its next mutation',async t=>{
 const {root,registry,image}=await fixture(t,true),adapter=new BeaconMemoryAdapter(),controller=new ImageController({registry,backend,signalRunner:new SignalRunner(),beaconAdapter:adapter,stateDir:join(root,'runtime')});let deployment=await controller.stageDeployment('cancel-race',image.digest);const generation=deployment.generations[0]!,sourceName=imageSignalName(image.digest,'watch',{id:generation.id});const now=new Date();await adapter.upsertInstance({id:'source',beaconName:sourceName,origin:'api',status:'stopped',desiredState:'running',incarnation:1,restartCount:0,config:'{}',createdAt:now,updatedAt:now});
 await controller.deployments.recordRollout(deployment.id,deployment.revision,{id:'operation',sourceInstance:'source',sourceName,targetInstance:`rollout-${'2'.repeat(64)}`,generation:generation.id,export:'watch',config:'{}',createdAt:now.toISOString()});deployment=await controller.deployments.get(deployment.id);
 const get=adapter.getInstance.bind(adapter);let cancelled=false;adapter.getInstance=async id=>{if(id==='source'&&!cancelled){cancelled=true;await controller.deployments.cancelRollout(deployment.id,'operation',deployment.revision);}return get(id);};await controller.reconcileRollouts();assert.equal((await get('source'))!.desiredState,'running');assert.equal(await get(`rollout-${'2'.repeat(64)}`),null);
});
