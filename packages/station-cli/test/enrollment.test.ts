import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, chmod, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StationClient } from "station-client";
import { run, parseArgs } from "../src/commands.js";
import { ContextStore } from "../src/store.js";
import { inviteWorker, joinWorker, leaveWorker, readEnrollmentFile } from "../src/enrollment.js";
import { EnrollmentAuthority } from "../../station-daemon/src/enrollment/authority.js";
import { v1EnrollmentAdminRoutes, v1EnrollmentWorkerRoutes } from "../../station-daemon/src/server/routes/v1/enrollment.js";
const token = "sti_" + "a".repeat(43), credential = "stw_" + "b".repeat(43);
const invitation = () => ({ format: "station.enrollment/v1", url: "https://hq.example", token, stationId: "worker", networkId: "fleet", expiresAt: new Date(Date.now() + 60_000).toISOString() });
const response = (data: unknown) => new Response(JSON.stringify({ data }));
test("network CLI invites, joins, lists, revokes and leaves without printing any credential", async t => {
  const home = await mkdtemp(join(tmpdir(), "station-enrollment-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ContextStore(join(home, "operator")); await store.add("hq", { url: "https://hq.example", token: "admin-secret", stationId: "hq" });
  const original = globalThis.fetch, write = process.stdout.write; let printed = "";
  const requests: {path:string; auth:string|null; body:any}[] = [];
  t.after(() => { globalThis.fetch = original; process.stdout.write = write; });
  process.stdout.write = ((chunk: any) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname, auth = new Headers(options?.headers).get("authorization"), body = options?.body ? JSON.parse(String(options.body)) : undefined;
    requests.push({ path, auth, body }); assert.equal(options?.redirect, "error");
    if (path.endsWith("/info")) return response({ protocol: "station.api/v1", version: "3.0.0", stationId: "hq", role: "headquarters", capabilities: [] });
    if (path.endsWith("/enrollments")) { assert.equal(auth, "Bearer admin-secret"); assert.deepEqual(body, {stationId:"worker",ttlMs:10000}); return response({ ...invitation(), url: "https://malicious.example" }); }
    if (path.endsWith("/join")) { assert.equal(auth, null); assert.equal(String(url), "https://hq.example/api/v1/network/join"); assert.deepEqual(body, {token,stationId:"worker",networkId:"fleet"}); return response({credential,stationId:"worker",networkId:"fleet",generation:"generation"}); }
    if (path.endsWith("/leave")) { assert.equal(auth, `Bearer ${credential}`); assert.deepEqual(body, {stationId:"worker",networkId:"fleet"}); return new Response(null,{status:204}); }
    if (options?.method === "DELETE") return new Response(null,{status:204});
    return response([{stationId:"worker",networkId:"fleet"}]);
  };
  const invite = join(home,"invite.json"), config = join(home,"worker.json");
  await run(parseArgs(["network","invite","worker","--ttl-ms","10000","--out",invite]),store);
  assert.equal(JSON.parse(await readFile(invite,"utf8")).url,"https://hq.example");
  const emptyStore = new ContextStore(join(home,"no-context"));
  await run(parseArgs(["network","join","--file",invite,"--out",config]),emptyStore);
  const saved = JSON.parse(await readFile(config,"utf8"));
  assert.deepEqual(saved,{role:"station",network:{id:"fleet",stationId:"worker",enrollment:{url:"https://hq.example",credential}}});
  if(process.platform!=="win32") { assert.equal((await stat(invite)).mode & 0o777,0o600); assert.equal((await stat(config)).mode & 0o777,0o600); }
  await run(parseArgs(["network","members"]),store); await run(parseArgs(["network","revoke","worker"]),store);
  await run(parseArgs(["network","leave","--file",config]),emptyStore);
  assert.equal(requests.filter(request=>request.path.endsWith("/join")).length,1);
  for(const secret of [token,credential,"admin-secret"]) assert.ok(!printed.includes(secret));
});
test("one-time enrollment fails before mutation on existing output, rejects changed identity and never retries failed joins", async t => {
  const home = await mkdtemp(join(tmpdir(), "station-enrollment-safety-")); t.after(()=>rm(home,{recursive:true,force:true}));
  const out = join(home,"config.json"); await writeFile(out,"keep",{mode:0o600});
  const original = globalThis.fetch; t.after(()=>{globalThis.fetch=original;}); let requests=0;
  globalThis.fetch=async()=>{requests++; return response({credential,stationId:"other",networkId:"fleet",generation:"one"});};
  await assert.rejects(joinWorker(JSON.stringify(invitation()),out),/EEXIST/); assert.equal(requests,0); assert.equal(await readFile(out,"utf8"),"keep");
  await rm(out); await assert.rejects(joinWorker(JSON.stringify(invitation()),out),/does not match/); assert.equal(requests,1); await assert.rejects(access(out));
  globalThis.fetch=async()=>{requests++; throw new Error(`transport leaked ${credential}`);};
  await assert.rejects(joinWorker(JSON.stringify(invitation()),out),error=>error instanceof Error && !error.message.includes(credential));
  assert.equal(requests,2); await assert.rejects(access(out));
  await assert.rejects(joinWorker(JSON.stringify({...invitation(),url:"http://remote.example"}),out),/HTTPS/); assert.equal(requests,2);
  await assert.rejects(inviteWorker(new StationClient({url:"https://hq.example",tenant:true}),"worker",out),/operator/); assert.equal(requests,2);
});
test("enrollment inputs reject links, publicly readable files and oversized secrets", async t => {
  const home=await mkdtemp(join(tmpdir(),"station-enrollment-input-")); t.after(()=>rm(home,{recursive:true,force:true}));
  const file=join(home,"invite.json"); await writeFile(file,JSON.stringify(invitation()),{mode:0o600});
  assert.equal(JSON.parse(await readEnrollmentFile(file)).token,token);
  const link=join(home,"link"); await symlink(file,link); await assert.rejects(readEnrollmentFile(link));
  if(process.platform!=="win32") { await chmod(file,0o644); await assert.rejects(readEnrollmentFile(file),/mode 0600/); await chmod(file,0o600); }
  await writeFile(file,"x".repeat(65537)); await assert.rejects(readEnrollmentFile(file),/64 KiB/);
});
test("CLI enrollment files round-trip through the real authority and HTTP handlers", async t => {
  const home=await mkdtemp(join(tmpdir(),"station-enrollment-routes-")); t.after(()=>rm(home,{recursive:true,force:true}));
  const authority=new EnrollmentAuthority({path:join(home,"authority.json"),networkId:"fleet"});
  const admin=v1EnrollmentAdminRoutes(authority), worker=v1EnrollmentWorkerRoutes(authority);
  const original=globalThis.fetch; t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,options)=> {
    const path=new URL(String(url)).pathname.replace(/^\/api\/v1/,"");
    const routes=path==="/network/enrollments"?admin:worker;
    return routes.request(`https://hq.example${path}`,options);
  };
  const invitationPath=join(home,"invite.json"), configPath=join(home,"worker.json");
  await inviteWorker(new StationClient({url:"https://hq.example"}),"worker",invitationPath);
  await joinWorker(await readEnrollmentFile(invitationPath),configPath);
  const text=await readEnrollmentFile(configPath), config=JSON.parse(text);
  assert.equal((await authority.admit("worker","fleet",config.network.enrollment.credential)).stationId,"worker");
  await assert.rejects(joinWorker(await readEnrollmentFile(invitationPath),join(home,"reused.json")));
  await leaveWorker(text);
  await assert.rejects(authority.admit("worker","fleet",config.network.enrollment.credential));
});
