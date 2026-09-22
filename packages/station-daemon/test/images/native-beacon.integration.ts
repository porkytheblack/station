import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileImageRegistry, DockerImageProcessBackend, startImageBeacon, executeImage } from 'station-images';

test('native Go beacon runs poll, dependency, heartbeat, restart and stop inside the production Docker policy',{skip:!process.env.STATION_IMAGE_DOCKER_IMAGE,timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'station-native-beacon-docker-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const arch=process.env.STATION_IMAGE_DOCKER_ARCH==='amd64'?'amd64':'arm64',binary=join(root,'native');
 execFileSync('go',['build','-o',binary,fileURLToPath(new URL('./fixtures/native-beacon.go',import.meta.url))],{env:{...process.env,GOOS:'linux',GOARCH:arch,CGO_ENABLED:'0',GOCACHE:join(tmpdir(),'station-native-fixture-go-cache')},timeout:45000});
 const registry=new FileImageRegistry(join(root,'registry')),blob=await registry.putBlob(await readFile(binary)),artifact={...blob,entrypoint:'native',runtime:'native' as const,platform:{os:'linux' as const,arch,abi:'none' as const}};
 const dependency=await registry.publish({format:'station.image/v1',protocol:'station.process/v1',name:'native/dependency',version:'1.0.0',artifacts:[artifact],exports:[{name:'echo',kind:'signal',requiredEnv:['IMAGE_TOKEN']}]});
 const beacon=await registry.publish({format:'station.image/v1',protocol:'station.process/v1',name:'native/beacon',version:'1.0.0',artifacts:[artifact],exports:[{name:'watch',kind:'beacon',mode:'poll',pollIntervalMs:50,startMode:'on-demand',requiredEnv:['IMAGE_TOKEN']}],dependencies:{echo:{image:`native/dependency@${dependency.digest}`,export:'echo',kind:'signal'}}});
 const backend=new DockerImageProcessBackend({image:process.env.STATION_IMAGE_DOCKER_IMAGE!,rootDir:join(root,'containers'),executable:process.env.STATION_IMAGE_DOCKER_EXECUTABLE??'/usr/local/bin/docker',seccompProfile:process.env.STATION_IMAGE_DOCKER_SECCOMP,target:{os:'linux',arch,abi:'none',runtimes:{node:22}},maxRuntimeMs:20000});
 const invoked:unknown[]=[];
 for(const incarnation of ['first','second']){
  const events:Readonly<Record<string,unknown>>[]=[],pending:Promise<unknown>[]=[];
  const session=await startImageBeacon({registry,reference:beacon.digest,exportName:'watch',backend,instanceId:'same-instance',incarnation,config:{message:'native-container'},environment:{allowedKeys:['IMAGE_TOKEN'],store:{IMAGE_TOKEN:'approved'}},onEvent:event=>events.push(event),trigger:async request=>{
   assert.equal(request.instanceId,'same-instance');assert.equal(request.incarnation,incarnation);assert.equal(request.alias,'echo');
   const work=executeImage({registry,reference:dependency.digest,exportName:'echo',input:request.input,runId:`dependency-${incarnation}`,backend,environment:{allowedKeys:['IMAGE_TOKEN'],store:{IMAGE_TOKEN:'approved'}}});pending.push(work);const result=await work;invoked.push(result.output);return `run-${incarnation}`;
  }});
  try{await session.ready;await session.poll('poll-one');await Promise.all(pending);await new Promise(resolve=>setTimeout(resolve,100));await session.poll('poll-two');assert.ok(events.some(event=>event.type==='beacon:heartbeat'));assert.equal(pending.length,1,'duplicate trigger id dispatches only once per incarnation');await session.stop();await session.done;assert.ok(events.some(event=>event.type==='beacon:stopped'));}finally{await session.stop().catch(()=>{});}
 }
 assert.deepEqual(invoked,['first','second'].map(incarnation=>({native:true,input:{via:'native-beacon',instanceId:'same-instance',incarnation,message:'native-container'},token:'approved'})));
 assert.deepEqual((await readdir(join(root,'containers'))).filter(name=>name.startsWith('invocation-')),[]);
});
