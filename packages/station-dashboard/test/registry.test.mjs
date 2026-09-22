import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePublication, publishPrepared, registryRequest, environmentBindings, registryPrefix } from '../src/app/components/registry-api.mjs';

function memoryStorage() { const data=new Map(); return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),data}; }
function fixture() {
  const bytes = Buffer.from('console.log("compiled");');
  const file = new File([bytes], 'echo.mjs');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const manifest = { format:'station.image/v1',protocol:'station.process/v1',name:'test/echo',version:'1.0.0',artifacts:[{entrypoint:file.name,size:file.size,digest}],exports:[{name:'echo',kind:'signal'}] };
  return {file,manifest};
}

test('publication verifies every artifact before any upload and uses exact checked bytes',async(t)=>{
  const {file,manifest}=fixture(); const requests=[];
  const old=globalThis.fetch; t.after(()=>{globalThis.fetch=old;});
  globalThis.fetch=async(url,options)=>{requests.push({url,options});if(options.method==='DELETE')return new Response(null,{status:204});return Response.json({data:url.endsWith('/images')?{digest:'published',manifest}: {id:'upload-one',size:file.size,digest:manifest.artifacts[0].digest,offset:options.method==='PATCH'||url.endsWith('/commit')?file.size:0,state:url.endsWith('/commit')?'committed':'open'}});};
  const second={...manifest,artifacts:[...manifest.artifacts,{entrypoint:'missing.mjs',size:1,digest:`sha256:${'a'.repeat(64)}`}]};
  await assert.rejects(preparePublication(second,[file]),/Missing or mismatched artifact/);
  assert.equal(requests.length,0);
  await assert.rejects(preparePublication(manifest,[new File(['wrong'],'echo.mjs')]),/Missing or mismatched/);
  await assert.rejects(preparePublication(manifest,[file,new File(['extra'],'extra.txt')]),/not declared/);
  const prepared=await preparePublication(manifest,[file]);
  const published=await publishPrepared(manifest,prepared,()=>{},{storage:memoryStorage()});
  assert.equal(published.digest,'published');
  assert.equal(requests.length,5);
  assert.equal(requests[0].url,"/api/v1/registry/uploads");
  assert.equal(Buffer.from(requests[1].options.body).toString(),await file.text());
  assert.equal(requests[0].options.credentials,'include');
  assert.equal(requests[4].url,'/api/v1/registry/images');
  assert.deepEqual(JSON.parse(requests[4].options.body),manifest);
});

test('failed artifact upload never publishes the manifest',async(t)=>{
  const {file,manifest}=fixture();const requests=[];const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
  globalThis.fetch=async(url)=>{requests.push(url);return Response.json({error:'payload_too_large'},{status:413});};
  await assert.rejects(publishPrepared(manifest,await preparePublication(manifest,[file]),()=>{},{storage:memoryStorage()}),/upload limit/);
  assert.equal(requests.length,1);assert.ok(!requests.includes('/api/v1/registry/images'));
});

test('registry error states explain missing execution, access and uncertain mutation outcomes',async(t)=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
  globalThis.fetch=async()=>Response.json({error:'image_execution_not_configured'},{status:409});
  await assert.rejects(registryRequest('/install',{method:'POST',body:'{}'}),/registry.execution/);
  globalThis.fetch=async()=>Response.json({error:'forbidden'},{status:403});
  await assert.rejects(registryRequest('/images'),/admin access/);
  globalThis.fetch=async()=>{throw new Error('network');};
  await assert.rejects(registryRequest('/run',{method:'POST',body:'{}'}),/may have completed/);
  await assert.rejects(registryRequest('/images'),/Cannot reach/);
});

test('resumable publication reconciles lost chunk responses on the fixed private target',async(t)=>{
 const {file,manifest}=fixture(), prepared=await preparePublication(manifest,[file]), storage=memoryStorage(), calls=[];
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let offset=0,committed=false,lost=true,denied=false;
 const status=()=>Response.json({data:{id:'resume-one',digest:manifest.artifacts[0].digest,size:file.size,offset,state:committed?'committed':'open'}},{headers:{'Upload-Max-Chunk-Bytes':'8'}});
 globalThis.fetch=async(url,options)=>{
   assert.ok(url.startsWith('/api/v1/stations/worker-a/registry/'));calls.push({url,method:options.method??'GET',offset:new Headers(options.headers).get('Upload-Offset')});
   if(url.endsWith('/images'))return Response.json({data:{manifest}});
   if((options.method??'GET')==='GET'&&denied)return Response.json({error:'forbidden'},{status:403});
   if(options.method==='PATCH'){assert.equal(Number(new Headers(options.headers).get('Upload-Offset')),offset);assert.equal(new Headers(options.headers).get('X-Chunk-SHA256'),'sha256:'+createHash('sha256').update(Buffer.from(options.body)).digest('hex'));offset+=options.body.byteLength;if(lost){lost=false;throw new Error('lost reply');}return status();}
   if(url.endsWith('/commit')){committed=true;return status();}
   if(options.method==='DELETE')return new Response(null,{status:204});
   return status();
 };
 const options={stationId:'worker-a',receiptScope:'https://hq.example',storage};
 await assert.rejects(publishPrepared(manifest,prepared,()=>{},options),/may have completed/);
 assert.equal(offset,8);assert.equal(storage.data.size,1);
 denied=true;await assert.rejects(publishPrepared(manifest,prepared,()=>{},options),/admin access/);assert.equal(offset,8);assert.equal(storage.data.size,1);denied=false;
 await publishPrepared(manifest,prepared,()=>{},options);
 assert.equal(calls.filter(call=>call.method==='POST'&&call.url.endsWith('/uploads')).length,1);
 assert.ok(calls.some(call=>call.method==='GET'&&call.url.endsWith('/resume-one')));
 assert.deepEqual(calls.filter(call=>call.method==='PATCH').map(call=>Number(call.offset)),[0,8,16]);assert.equal(storage.data.size,0);
});
test('binding editor requires env references or explicitly non-secret literals and rejects ambiguous keys',()=>{
 assert.deepEqual({...environmentBindings([{key:'API_TOKEN',kind:'reference',value:'SECRET_TOKEN'},{key:'MODE',kind:'literal',value:'production',nonsecret:true}])},{API_TOKEN:{fromEnv:'SECRET_TOKEN'},MODE:{value:'production'}});
 assert.throws(()=>environmentBindings([{key:'TOKEN',kind:'literal',value:'credential'}]),/no secret/);
 assert.throws(()=>environmentBindings([{key:'DUP',kind:'reference',value:'ONE'},{key:'DUP',kind:'reference',value:'TWO'}]),/unique/);
 assert.throws(()=>environmentBindings([{key:'STATION_TOKEN',kind:'reference',value:'ONE'}]),/reserved/);
 assert.throws(()=>registryPrefix('https://evil.example'),/Invalid/);
});
