import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { FileImageRegistry, type ImageManifest } from 'station-images';
import { SignalRunner, MemoryAdapter } from 'station-signal';
import { imageRegistryRoutes } from '../../../src/server/routes/v1/registry.js';
import { registrySource } from '../../../src/registry/source.js';
import { ImageController } from '../../../src/images/controller.js';
import { imageSignalName } from '../../../src/images/runtime.js';

const token = 'registry-network-fixture-token';
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'station-registry-network-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const registry = new FileImageRegistry(join(root,'headquarters'));
  const app = new Hono(); const requests: string[] = [];
  const behavior = { corruptBlob: false, badRecord: false, redirect: '' };
  app.use('*', async(c,next)=>{
    requests.push(c.req.path);
    if(c.req.header('authorization')!==`Bearer ${token}`) return c.json({error:'unauthorized'},401);
    c.set('authType','api-key'); c.set('scopes',['admin']);
    if(behavior.redirect) return c.redirect(behavior.redirect,307);
    if(behavior.corruptBlob && c.req.path.includes('/registry/blobs/')) {
      const original=await registry.getBlob(decodeURIComponent(c.req.path.split('/').at(-1)!) as `sha256:${string}`);
      return c.body(new Uint8Array(Buffer.alloc(original.length,120)));
    }
    if(behavior.badRecord && c.req.path.endsWith('/registry/images')) {
      const records=await registry.list();
      return c.json({data:records.map(record=>({...record,digest:`sha256:${'f'.repeat(64)}`}))});
    }
    await next();
  });
  app.route('/api/v1',imageRegistryRoutes(registry));
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  if(!server.listening) await once(server,'listening');
  t.after(()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections?.();server.close(error=>error?reject(error):resolve());}));
  const address=server.address(); assert.ok(address&&typeof address==='object');
  const source=registrySource({url:`http://127.0.0.1:${address.port}`,token});
  const marker=join(root,'uploaded-code-executed');
  const bytes=Buffer.from(`import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected');\n`);
  const { digest: blob }=await registry.putBlob(bytes);
  const publish=async(name:string,os:'linux'|'win32'='linux',dependencies?:ImageManifest['dependencies'])=>registry.publish({
    format:'station.image/v1',protocol:'station.process/v1',name,version:'1.0.0',
    artifacts:[{platform:{os,arch:'amd64'},runtime:'node',runtimeMajor:22,digest:blob,size:bytes.length,entrypoint:'entry.mjs'}],
    exports:[{name:'run',kind:'signal'}],...(dependencies?{dependencies}:{}),
  });
  const worker=(name:string)=>{
    const workerRegistry=new FileImageRegistry(join(root,name,'registry'));
    const signalRunner=new SignalRunner({adapter:new MemoryAdapter(),maxConcurrent:0});
    const controller=new ImageController({registry:workerRegistry,source,signalRunner,stateDir:join(root,name,'runtime'),backend:{kind:'trusted-local',allowUnsafeHostExecution:true,target:{os:'linux',arch:'amd64',runtimes:{node:22}},nodeExecutable:process.execPath}});
    return {registry:workerRegistry,signals:signalRunner,controller};
  };
  return {root,registry,source,requests,behavior,publish,worker,marker,address:`http://127.0.0.1:${address.port}`};
}

test('HTTP Headquarters catalog installs on multiple compatible workers while unsupported roots/dependencies do not block others',async t=>{
  const f=await fixture(t);
  const unsupported=await f.publish('test/windows-only','win32');
  const blocked=await f.publish('test/depends-on-windows','linux',{windows:{image:`test/windows-only@${unsupported.digest}`,export:'run',kind:'signal'}});
  const good=await f.publish('test/portable-worker');
  const catalog=await f.source.list(); assert.equal(catalog.length,3);
  for(const name of ['worker-a','worker-b']) {
    const worker=f.worker(name);
    await worker.controller.sync([unsupported,blocked,good]);
    assert.equal(worker.signals.hasSignal(imageSignalName(good.digest,'run')),true);
    assert.equal(worker.signals.hasSignal(imageSignalName(unsupported.digest,'run')),false);
    assert.equal(worker.signals.hasSignal(imageSignalName(blocked.digest,'run')),false);
    assert.equal((await worker.registry.resolve(good.digest)).digest,good.digest);
    const before=f.requests.length;
    await worker.controller.sync([good]);
    assert.equal(f.requests.length,before,'already-synced digest should not be downloaded again');
    const result=await worker.controller.run(good.digest,'run',{value:1});
    assert.equal(result.kind,'signal');
    assert.equal(result.registeredName,imageSignalName(good.digest,'run'));
  }
  await assert.rejects(access(f.marker),'install must never import uploaded JavaScript in the controller');
  assert.ok(f.requests.some(path=>path.startsWith('/api/v1/registry/blobs/')));
});

test('corrupt upstream bytes fail digest verification without registering or executing code and can be retried',async t=>{
  const f=await fixture(t),record=await f.publish('test/corrupted');
  const worker=f.worker('worker');
  f.behavior.corruptBlob=true;
  await assert.rejects(worker.controller.sync([record]),{code:'digest_mismatch'});
  assert.equal(worker.signals.hasSignal(imageSignalName(record.digest,'run')),false);
  await assert.rejects(worker.registry.resolve(record.digest),{code:'not_found'});
  await assert.rejects(access(f.marker));
  f.behavior.corruptBlob=false;
  await worker.controller.sync([record]);
  assert.equal(worker.signals.hasSignal(imageSignalName(record.digest,'run')),true);
});

test('upstream catalog validates immutable identities, enforces authentication and refuses redirects',async t=>{
  const f=await fixture(t); await f.publish('test/catalog');
  await assert.rejects(registrySource({url:f.address,token:'wrong-token'}).list(),{code:'upstream_unavailable'});
  f.behavior.badRecord=true;
  await assert.rejects(f.source.list(),{code:'digest_mismatch'});
  f.behavior.badRecord=false;
  let destinationCalls=0;
  const destination=serve({hostname:'127.0.0.1',port:0,fetch:()=>{destinationCalls++;return Response.json({data:[]});}});
  if(!destination.listening) await once(destination,'listening');
  t.after(()=>new Promise<void>((resolve,reject)=>{destination.closeAllConnections?.();destination.close(error=>error?reject(error):resolve());}));
  const address=destination.address();assert.ok(address&&typeof address==='object');
  f.behavior.redirect=`http://127.0.0.1:${address.port}/leak`;
  await assert.rejects(f.source.list());
  assert.equal(destinationCalls,0);
});
