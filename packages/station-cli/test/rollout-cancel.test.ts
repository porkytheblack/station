import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {run,parseArgs} from '../src/commands.js';
import {ContextStore} from '../src/store.js';
test('deployment rollout-cancel forwards exact revision and escaped identity once',async t=>{
 const home=await mkdtemp(join(tmpdir(),'station-rollout-cli-'));t.after(()=>rm(home,{recursive:true,force:true}));const store=new ContextStore(home);await store.add('hq',{url:'https://hq.example',token:'operator'});
 const original=globalThis.fetch,write=process.stdout.write;t.after(()=>{globalThis.fetch=original;process.stdout.write=write;});process.stdout.write=(()=>true) as typeof write;const requests:any[]=[];
 globalThis.fetch=async(url,options)=>{const path=new URL(String(url)).pathname;if(path.endsWith('/info'))return Response.json({data:{protocol:'station.api/v1',version:'3.0.0',stationId:'hq',role:'headquarters',capabilities:[]}});requests.push({path,method:options?.method,body:JSON.parse(String(options?.body))});return Response.json({data:{cancelledAt:new Date().toISOString()}});};
 await run(parseArgs(['deployments','rollout-cancel','deployment','--json',JSON.stringify({rolloutId:'operation',expectedRevision:7})]),store);assert.deepEqual(requests,[{path:'/api/v1/registry/deployments/deployment/rollouts/operation/cancel',method:'POST',body:{expectedRevision:7}}]);
 await assert.rejects(run(parseArgs(['deployments','rollout-cancel','deployment','--json','{"rolloutId":"operation","expectedRevision":7,"extra":true}']),store),/rolloutId/);assert.equal(requests.length,1);
});
