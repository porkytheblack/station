/** Opt-in real Chromium dashboard flow against a deterministic HTTP API fixture.
 * Build station-dashboard first, then STATION_DASHBOARD_BROWSER_TEST=1 node --test this-file.
 * Backend execution itself is covered by station-daemon image integration tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const listen=async(server)=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const digest=(bytes)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture(version) { const bytes=Buffer.from(`console.log(${JSON.stringify(version)});`);return {bytes,manifest:{format:'station.image/v1',protocol:'station.process/v1',name:'acme/echo',version,artifacts:[{platform:{os:'any',arch:'any'},runtime:'node',runtimeMajor:22,entrypoint:'echo.mjs',size:bytes.length,digest:digest(bytes)}],exports:[{name:'echo',kind:'signal',inputSchema:{type:'object'}}]}}; }

test('nested registry publication, install, invoke and deployment activation/rollback in real Chromium', {skip:!process.env.STATION_DASHBOARD_BROWSER_TEST,timeout:120000},async()=>{
  const {chromium}=createRequire(new URL('../../../examples/17-browser/package.json',import.meta.url))('playwright');
  const first=fixture('1.0.0'),second=fixture('2.0.0');
  const images=[{digest:digest(JSON.stringify(first.manifest)),manifest:first.manifest}];const calls=[];const deployments=[];let conflict=false;let uploadCount=0;let uploadOffset=0;let uploadCommitted=false;let lostChunk=true;let uploadDigest;let uploadSize;
  const daemon=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://local');const route=url.pathname.replace('/api/v1/stations/worker-a/registry','/api/v1/registry');let body='';for await(const chunk of req)body+=chunk;let value;try{value=body?JSON.parse(body):null;}catch{}
    const send=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json','Upload-Max-Chunk-Bytes':'8'});res.end(JSON.stringify(status<400?{data}:data));};
    calls.push({path:url.pathname,method:req.method,value,offset:req.headers['upload-offset']});
    if(route==='/api/auth/check')return send({authenticated:true,authRequired:false});
    if(route==='/api/v1/stations')return send([{id:'worker-a',name:'Worker A',role:'station',status:'online'}]);
    if(route==='/api/v1/registry/images'&&req.method==='GET')return send(images);
    const uploadStatus=()=>({id:'upload-one',digest:uploadDigest,size:uploadSize,offset:uploadOffset,state:uploadCommitted?'committed':'open'});
    if(route==='/api/v1/registry/uploads'&&req.method==='POST'){uploadCount++;uploadDigest=value.digest;uploadSize=value.size;return send(uploadStatus(),201);}
    if(route==='/api/v1/registry/uploads/upload-one'&&req.method==='GET')return send(uploadStatus());
    if(route==='/api/v1/registry/uploads/upload-one'&&req.method==='PATCH'){assert.equal(Number(req.headers['upload-offset']),uploadOffset);assert.equal(req.headers['x-chunk-sha256'],digest(Buffer.from(body)));uploadOffset+=Buffer.byteLength(body);if(lostChunk){lostChunk=false;return send({error:'reply_lost'},503);}return send(uploadStatus());}
    if(route==='/api/v1/registry/uploads/upload-one/commit'){assert.equal(uploadOffset,uploadSize);uploadCommitted=true;return send(uploadStatus());}
    if(route==='/api/v1/registry/uploads/upload-one'&&req.method==='DELETE'){res.writeHead(204);return res.end();}
    if(route==='/api/v1/registry/images'&&req.method==='POST'){const image={digest:digest(JSON.stringify(value)),manifest:value};images.push(image);return send(image,201);}
    if(route==='/api/v1/registry/install')return send({image:images.find(item=>item.digest===value.reference),exports:[{registeredName:'immutable-echo'}]},201);
    if(route==='/api/v1/registry/run')return send({kind:'signal',id:'run-fixture',registeredName:'immutable-echo',image:value.reference},201);
    if(route==='/api/v1/registry/tags')return send(value);
    if(route==='/api/v1/registry/deployments'&&req.method==='GET')return send(deployments);
    if(route==='/api/v1/registry/deployments'&&req.method==='POST'){
      const image=images.find(item=>item.digest===value.reference||`${item.manifest.name}@${item.manifest.version}`===value.reference);
      if(!image)return send({error:'not_found'},404);
      let deployment=deployments.find(item=>item.name===value.name);
      if(!deployment){deployment={id:'deployment-a',name:value.name,revision:0,generations:[],history:[]};deployments.push(deployment);}
      const gen={id:`generation-${deployment.generations.length+1}`,image,aliases:value.aliases??{echo:'echo'},bindings:value.bindings??{},createdAt:new Date().toISOString()};deployment.generations.push(gen);deployment.revision++;deployment.history.push({revision:deployment.revision,action:'stage',generation:gen.id,at:new Date().toISOString()});return send(deployment,201);
    }
    const change=route.match(/\/registry\/deployments\/([^/]+)\/(activate|rollback|drain|run)$/);
    if(change){const deployment=deployments.find(item=>item.id===change[1]);if(change[2]==='run')return send({id:'deployment-run',kind:'signal',registeredName:'immutable-echo',generation:deployment.activeGeneration});if(conflict){conflict=false;return send({error:'revision_conflict'},409);}assert.equal(value.expectedRevision,deployment.revision);deployment.activeGeneration=change[2]==='drain'?undefined:value.generation;deployment.revision++;deployment.history.push({revision:deployment.revision,action:change[2],generation:value.generation,at:new Date().toISOString()});return send(deployment);}
    return send({error:'not_found'},404);
  });
  const daemonPort=await listen(daemon);const reservation=http.createServer();const port=await listen(reservation);await new Promise(r=>reservation.close(r));
  const child=spawn(process.execPath,[`${root}/packages/station-dashboard/bin/station-dashboard.mjs`],{cwd:root,env:{...process.env,STATION_DAEMON_URL:`http://127.0.0.1:${daemonPort}`,PORT:String(port),HOSTNAME:'127.0.0.1'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);let browser; let page;
  try{
    for(let n=0;;n++){try{const r=await fetch(`http://127.0.0.1:${port}/`);if(r.ok)break;}catch{}if(n>80)throw new Error(output);await new Promise(r=>setTimeout(r,100));}
    browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(10000);const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/registry`);await page.getByLabel('Registry Station',{exact:true}).selectOption('worker-a');await page.waitForURL('**/registry?registryStation=worker-a');await page.getByRole('link',{name:/acme\/echo/}).click();await page.getByRole('link',{name:/1.0.0/}).click();await page.getByRole('heading',{name:'Compiled artifacts'}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Run export',exact:true}).count(),0,'overview must not show invocation form');
    await page.getByRole('link',{name:'Install',exact:true}).click();await page.getByRole('button',{name:'Install version',exact:true}).click();await page.getByText('Version installed.',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Exports',exact:true}).click();await page.getByRole('link',{name:/echo.*signal/}).click();await page.getByLabel('Input JSON').fill('{"message":"hello"}');assert.equal(await page.getByLabel('Execution placement').inputValue(),'worker-a');assert.equal(await page.getByLabel('Execution placement').isDisabled(),true);await page.getByRole('button',{name:'Run export',exact:true}).click();await page.getByText('run-fixture',{exact:true}).waitFor();assert.equal(calls.find(c=>c.path.endsWith('/registry/run')).value.stationId,'worker-a');
    await page.goto(`http://127.0.0.1:${port}/registry/publish?registryStation=worker-a`);await page.getByLabel('Manifest (.json)').setInputFiles({name:'station-image.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(second.manifest))});await page.getByLabel('Compiled artifacts',{exact:true}).setInputFiles({name:'echo.mjs',mimeType:'text/javascript',buffer:Buffer.from('wrong')});await page.getByRole('button',{name:'Verify and publish'}).click();await page.getByRole('alert').filter({hasText:'mismatched artifact'}).waitFor();assert.equal(uploadCount,0);
    await page.getByLabel('Compiled artifacts',{exact:true}).setInputFiles({name:'echo.mjs',mimeType:'text/javascript',buffer:second.bytes});await page.getByRole('button',{name:'Verify and publish'}).click();await page.getByRole('alert').filter({hasText:'request failed'}).waitFor();assert.equal(uploadOffset,8);await page.getByRole('button',{name:'Resume / publish'}).click();await page.getByRole('heading',{name:'acme/echo · 2.0.0',exact:true}).waitFor();await page.getByRole('heading',{name:'Compiled artifacts'}).waitFor();assert.equal(uploadCount,1);
    await page.goto(`http://127.0.0.1:${port}/registry/deployments/stage?registryStation=worker-a`);await page.getByLabel('Deployment name').fill('echo-prod');await page.getByLabel('Image reference',{exact:true}).fill('acme/echo@1.0.0');await page.getByRole('button',{name:'Add environment binding'}).click();await page.getByLabel('Binding 1 key',{exact:true}).fill('API_TOKEN');await page.getByLabel('Binding 1 environment key',{exact:true}).fill('WORKER_TOKEN');await page.getByRole('button',{name:'Add environment binding'}).click();await page.getByLabel('Binding 2 key',{exact:true}).fill('MODE');await page.getByLabel('Binding 2 source',{exact:true}).selectOption('literal');await page.getByLabel('Binding 2 non-secret value',{exact:true}).fill('production');await page.getByLabel('I confirm binding 2 contains no secret',{exact:true}).check();await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'/tmp/station-registry-bindings.png',fullPage:true});await page.getByRole('button',{name:'Stage generation',exact:true}).click();await page.getByText('Environment reference: WORKER_TOKEN',{exact:true}).waitFor();assert.deepEqual(deployments[0].generations[0].bindings,{API_TOKEN:{fromEnv:'WORKER_TOKEN'},MODE:{value:'production'}});await page.getByRole('button',{name:'Activate generation',exact:true}).click();await page.getByText('This generation is active.',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Stage update',exact:true}).click();await page.getByLabel('Image reference',{exact:true}).fill('acme/echo@2.0.0');await page.getByRole('button',{name:'Stage generation',exact:true}).click();conflict=true;await page.getByRole('button',{name:'Activate generation',exact:true}).click();await page.getByRole('alert').filter({hasText:'Another operator'}).waitFor();await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('button',{name:'Activate generation',exact:true}).click();await page.getByText('This generation is active.',{exact:true}).waitFor();
    await page.getByRole('link',{name:'Generations',exact:true}).click();await page.getByRole('link',{name:/acme\/echo.*1.0.0/}).click();await page.getByRole('button',{name:'Roll back to this generation',exact:true}).click();await page.getByRole('button',{name:'Roll back generation',exact:true}).click();await page.getByText('This generation is active.',{exact:true}).waitFor();assert.equal(deployments[0].activeGeneration,'generation-1');
    await page.getByRole('link',{name:'Invoke',exact:true}).click();await page.getByRole('button',{name:'Invoke alias',exact:true}).click();await page.getByText('deployment-run',{exact:true}).waitFor();
    await page.getByRole('link',{name:'History',exact:true}).click();await page.screenshot({path:'/tmp/station-registry-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>Math.abs(document.querySelector('.station-sidebar').getBoundingClientRect().width-48)<1);await page.screenshot({path:'/tmp/station-registry-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile layout should not overflow');await page.getByRole('link',{name:'Drain',exact:true}).click();await page.getByRole('button',{name:'Drain deployment',exact:true}).click();await page.getByText('No active generation',{exact:false}).waitFor();assert.equal(deployments[0].activeGeneration,undefined);await page.getByRole('link',{name:'Invoke',exact:true}).click();await page.getByText('Activate a generation before invoking this deployment.',{exact:true}).waitFor();assert.deepEqual(browserErrors,[]);assert.ok(calls.filter(call=>['POST','PUT','PATCH','DELETE'].includes(call.method)).every(call=>call.path.startsWith('/api/v1/stations/worker-a/registry/')));assert.ok(page.url().includes('registryStation=worker-a'));
  }catch(error){if(page){console.error("URL",page.url(),await page.locator("main").innerText().catch(()=>""));await page.screenshot({path:"/tmp/station-registry-failure.png",fullPage:true});}throw error;}finally{await browser?.close();child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,6000))]);if(child.exitCode===null)child.kill('SIGKILL');await new Promise(r=>daemon.close(r));}
});
