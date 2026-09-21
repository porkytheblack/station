import test from "node:test";
import assert from "node:assert/strict";
import { StationClient } from "station-client";
import { StationTuiModel } from "../src/tui.js";
test("TUI selection/filter/paging are read-only and mutations require explicit confirmation", async () => {
  const requests: { path: string; body: any }[] = [];
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (options?.method !== "GET") requests.push({ path, body: JSON.parse(String(options?.body)) });
    const data = path.endsWith("/signals") ? Array.from({ length: 25 }, (_, i) => ({ name: `signal-${i}` })) : { name: "signal-24", accepted: true };
    return new Response(JSON.stringify({ data }));
  } });
  const model = new StationTuiModel(client); await model.refresh(); await model.select(2);
  assert.equal(model.rows.length, 12); model.next(); assert.equal(model.page, 1);
  model.setFilter("signal-24"); assert.equal(model.rows.length, 1); await model.select(0);
  assert.equal(model.actions()[0].target, "https://hq.example · signal-24");
  assert.deepEqual(await model.mutate(0, { secret: "not echoed" }, false), { cancelled: true }); assert.equal(requests.length, 0);
  await model.mutate(0, { message: "hello" }, true);
  assert.deepEqual(requests, [{ path: "/api/v1/trigger", body: { signalName: "signal-24", input: { message: "hello" } } }]);
  await model.back(); assert.equal(model.view.kind, "signals");
});
test("TUI nested execution resources preserve tenant and owner identity on confirmed actions", async () => {
  const requests: any[] = [];
  const client = new StationClient({ url: "https://hq.example", tenant: true }, { fetch: async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/tenant/execution")) return new Response(JSON.stringify({ data: [{ stationId: "owner", capabilities: { sandbox: true, browser: false } }] }));
    assert.equal(path, "/api/v1/tenant/stations/owner/execution/sandbox");
    const body = JSON.parse(String(options?.body)); requests.push(body);
    return new Response(JSON.stringify({ data: body.method === "list" ? [{ id: "sandbox" }] : { id: "sandbox" } }));
  } });
  const model = new StationTuiModel(client); await model.refresh(); await model.select(8); await model.select(0);
  await assert.rejects(model.select(1), /capability/);
  await model.select(0); await model.select(0);
  await assert.rejects(model.mutate(0, { id: "other", command: "whoami" }, true), /overridden/);
  await model.mutate(0, { command: "whoami" }, true);
  assert.deepEqual(requests.at(-1), { method: "exec", id: "sandbox", command: "whoami" });
  assert.match(model.actions()[1].target, /worker owner/);
});
test("live refresh cannot replace a navigated view or reorder rows during typed input", async () => {
  let resolvePending!: (value: Response) => void, defer = false;
  const client = new StationClient({ url: "https://hq.example" }, { fetch: async (url) => {
    if (defer && String(url).endsWith("/signals")) return new Promise<Response>(resolve => { resolvePending = resolve; });
    return new Response(JSON.stringify({ data: [{ name: "original" }] }));
  } });
  const model = new StationTuiModel(client); await model.refresh(); await model.select(2);
  defer = true;
  let editing = false;
  const refresh = model.refresh(() => !editing); editing = true;
  resolvePending(new Response(JSON.stringify({ data: [{ name: "reordered" }] })));
  assert.equal(await refresh, false); assert.equal((model.rows[0] as {name:string}).name, "original");
  const stale = model.refresh(); await model.back();
  resolvePending(new Response(JSON.stringify({ data: [{ name: "late" }] })));
  assert.equal(await stale, false); assert.equal(model.view.kind, "home"); assert.equal((model.rows[0] as {name:string}).name, "health");
});

test("browser TUI nests session pages, profiles, recordings, diagnostics, audit, checkpoints and artifact receipts",async()=>{
 const requests:any[]=[];
 const client=new StationClient({url:"https://hq.example",tenant:true},{fetch:async(url,options)=>{
  if(String(url).endsWith("/tenant/execution"))return Response.json({data:[{stationId:"browser-owner",capabilities:{browser:true,sandbox:false}}]});
  assert.equal(new URL(String(url)).pathname,"/api/v1/tenant/stations/browser-owner/execution/browser");
  const body=JSON.parse(String(options?.body));requests.push(body);
  const byMethod:Record<string,unknown>={list:[{id:"session"}],profiles:[{id:"profile",inUse:false}],recordings:[{id:"recording",sessionId:"session"},{id:"foreign",sessionId:"other"}],recording:{frames:[{id:"frame",bytes:123}]},audit:[{sessionId:"session",event:"opened"},{sessionId:"other",event:"opened"}],checkpoints:[{id:"checkpoint",sessionId:"session"}]};
  const data=body.method==="execute"?(body.command.op==="pages"?[{id:"page",title:"Page",selected:true}]:body.command.op==="traceStop"?{id:"trace",mimeType:"application/zip",bytes:80}:{trace:{status:"idle"}}):byMethod[body.method]??{};
  return Response.json({data});
 }});
 const model=new StationTuiModel(client);await model.refresh();await model.select(8);await model.select(0);await model.select(1);await model.select(0);
 const menu=async(name:string)=>model.select(model.rows.findIndex(row=>(row as any).name===name));
 await menu("Pages");await model.select(0);assert.equal(model.actions()[0].label,"Select page");const before=requests.length;await model.mutate(0,{},false);assert.equal(requests.length,before);await model.mutate(0,{},true);assert.deepEqual(requests.at(-1),{method:"execute",id:"session",command:{op:"selectPage",pageId:"page"}});
 await assert.rejects(model.mutate(0,{command:{op:"closePage",pageId:"other"}},true),/overridden/);await model.back();await model.back();
 await menu("Profiles (worker)");await model.select(0);await model.mutate(1,{},true);assert.deepEqual(requests.at(-1),{method:"open",options:{profileId:"profile"}});await model.back();await model.back();
 await menu("Recordings");assert.equal(model.rows.length,1);await model.select(0);await model.select(0);assert.equal((model.data as any).bytes,123);assert.ok(!requests.some(row=>row.method==="recordingFrame"));await model.back();await model.back();await model.back();
 await menu("Diagnostics");await model.mutate(1,{},true);await model.back();await menu("Artifacts (this TUI session)");assert.equal(model.rows.length,1);await model.select(0);await model.mutate(0,{},true);assert.deepEqual(requests.at(-1),{method:"execute",id:"session",command:{op:"downloadDelete",artifactId:"trace"}});await model.back();await model.back();
 await menu("Audit");assert.equal(model.rows.length,1);await model.back();await menu("Checkpoints");await model.select(0);await model.mutate(0,{},true);assert.deepEqual(requests.at(-1),{method:"checkpointResume",id:"checkpoint"});
});

test("sandbox TUI nests bounded directories, terminals, services and local command receipts with pinned subresource actions",async()=>{
 const requests:any[]=[];
 const client=new StationClient({url:"https://hq.example"},{fetch:async(url,options)=>{
  if(String(url).endsWith("/execution"))return Response.json({data:[{stationId:"worker",capabilities:{sandbox:true,browser:false}}]});
  const body=JSON.parse(String(options?.body));requests.push(body);assert.equal(new URL(String(url)).pathname,"/api/v1/stations/worker/execution/sandbox");
  let data:unknown={};if(body.method==="list")data=[{id:"workspace"}];if(body.method==="exec")data={id:"command",sandboxId:"workspace",stdout:"ok"};if(body.method==="listFiles")data=body.path==="."?{entries:[{name:"src",path:"src",type:"directory"}]}:{entries:[{name:"index.js",path:"src/index.js",type:"file",size:20}]};if(body.method==="terminals")data=[{id:"terminal"}];if(body.method==="services")data=[{id:"service"}];return Response.json({data});
 }});
 const model=new StationTuiModel(client);await model.refresh();await model.select(8);await model.select(0);await model.select(0);await model.select(0);
 const menu=async(name:string)=>model.select(model.rows.findIndex(row=>(row as any).name===name));
 await model.mutate(0,{command:"whoami"},true);await menu("Commands (this TUI session)");assert.equal(model.rows.length,1);await model.select(0);await model.mutate(0,{},true);assert.deepEqual(requests.at(-1),{method:"cancel",id:"workspace",runId:"command"});await model.back();await model.back();
 await menu("Files");await model.select(0);assert.equal(requests.at(-1).path,"src");await model.select(0);assert.ok(!requests.some(row=>row.method==="readFile"));await assert.rejects(model.mutate(0,{path:"elsewhere"},true),/overridden/);await model.mutate(0,{},true);assert.equal(requests.at(-1).path,"src/index.js");await model.back();await model.back();await model.back();
 await menu("Terminals");await model.select(0);await model.mutate(0,{data:"pwd\n"},true);assert.deepEqual(requests.at(-1),{method:"terminalInput",id:"workspace",terminalId:"terminal",data:"pwd\n"});await assert.rejects(model.mutate(2,{terminalId:"other"},true),/overridden/);await model.back();await model.back();
 await menu("Services");await model.select(0);await model.mutate(1,{},true);assert.deepEqual(requests.at(-1),{method:"restartService",id:"workspace",serviceId:"service"});
});

test("TUI display redacts common secret fields and JSON strings without changing underlying action payloads",async()=>{
 const {redactTuiValue}=await import("../src/tui.js");
 const raw={input:JSON.stringify({apiKey:"hidden",nested:{password:"hidden"},safe:1}),env:[{key:"ACCESS_TOKEN",value:"hidden"},{key:"PUBLIC",value:"visible"}],secret:true,value:"hidden",base64:"aGVsbG8=",nested:{controlToken:"hidden"}};
 const rendered=JSON.stringify(redactTuiValue(raw));assert.ok(!rendered.includes("hidden"));assert.ok(!rendered.includes("aGVsbG8="));assert.ok(rendered.includes("visible"));assert.equal(JSON.parse(raw.input).apiKey,"hidden");assert.equal(raw.base64,"aGVsbG8=");
});

test("registry TUI nests versions and exports and deployment generations without mutating on navigation",async()=>{
 const digest=`sha256:${"a".repeat(64)}`,record={digest,manifest:{name:"test/app",version:"1.0.0",exports:[{name:"echo",kind:"signal"}]}},requests:any[]=[];
 const client=new StationClient({url:"https://hq.example"},{fetch:async(url,options)=>{const path=new URL(String(url)).pathname;const data=path.endsWith("/images")?[record]:path.endsWith("/resolve")?record:path.endsWith("/deployments")?[{id:"deployment"}]:path.endsWith("/deployments/deployment")?{id:"deployment",generations:[{id:"generation",image:record}],history:[]}:{};if(options?.method==="POST")requests.push(JSON.parse(String(options.body)));return Response.json({data});}});
 const model=new StationTuiModel(client);await model.refresh();await model.select(6);await model.select(0);await model.select(1);assert.equal(model.rows.length,1);await model.back();await model.select(2);await model.select(0);assert.equal(requests.length,0);await model.mutate(0,{message:"hello"},true);assert.deepEqual(requests[0],{reference:`test/app@${digest}`,export:"echo",input:{message:"hello"}});
 await model.back();await model.back();await model.back();await model.back();await model.select(7);await model.select(0);await model.select(1);assert.equal((model.rows[0] as any).id,"generation");await model.select(0);assert.equal((model.data as any).image.digest,digest);
});

test("unsupported specialized methods keep the previous navigation and never expose stale resource actions",async()=>{
 const client=new StationClient({url:"https://hq.example"},{fetch:async(url,options)=>{
  if(String(url).endsWith("/execution"))return Response.json({data:[{stationId:"worker",capabilities:{sandbox:true,browser:false}}]});
  const body=JSON.parse(String(options?.body));if(body.method==="listFiles")return Response.json({error:"unsupported",message:"This adapter does not support file operations."},{status:400});return Response.json({data:body.method==="list"?[{id:"workspace"}]:{}});
 }});
 const model=new StationTuiModel(client);await model.refresh();await model.select(8);await model.select(0);await model.select(0);await model.select(0);const previous=model.view;await assert.rejects(model.select(1),/unsupported/);assert.equal(model.view,previous);assert.equal((model.rows[1] as any).name,"Files");
});
