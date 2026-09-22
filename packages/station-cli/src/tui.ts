import { createInterface } from "node:readline/promises";
import { StationClient, type ExecutionRequest } from "station-client";
import { boundedFile } from "./images.js";
import { watchStationEvents, type LiveStatus } from "./live.js";

type Kind = "home" | "health" | "workers" | "signals" | "broadcasts" | "beacons" | "instances" | "runs" | "images" | "deployments" | "owners" | "sandboxes" | "browsers" | "detail" | "environment" | "nested";
interface View { kind: Kind; title: string; load: (signal?: AbortSignal) => Promise<unknown>; owner?: string; resource?: string; parentKind?: Kind; beaconName?: string; selectRow?: (row: Record<string, unknown>) => Promise<void>; customActions?: () => TuiAction[] }
export interface TuiAction { label: string; target: string; input?: boolean; perform: (input: Record<string, unknown>) => Promise<unknown> }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const encode = encodeURIComponent;
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const sections = ["health", "workers", "signals", "broadcasts", "beacons", "runs", "images", "deployments", "owners", "environment"] as const;
/** Navigation and mutations are separate so displaying a selection never executes it. */
export class StationTuiModel {
  private stack: View[] = [];
  view: View = { kind: "home", title: "Home", load: async () => sections.map(name => ({ name })) };
  data: unknown = []; page = 0; filter = ""; readonly pageSize = 12;
  private refreshSequence = 0;
  private receipts = new Map<string, Record<string, unknown>[]>();
  constructor(readonly client: StationClient, private readonly signal?: AbortSignal) {}
  async refresh(accept: () => boolean = () => true) {
    const view = this.view, sequence = ++this.refreshSequence;
    const data = await view.load(this.signal);
    if (view !== this.view || sequence !== this.refreshSequence || !accept()) return false;
    this.data = data; if (this.page * this.pageSize >= this.filtered.length) this.page = 0;
    return true;
  }
  get filtered(): unknown[] { const rows = Array.isArray(this.data) ? this.data : []; return rows.filter(row => JSON.stringify(row).toLowerCase().includes(this.filter.toLowerCase())); }
  get rows() { return this.filtered.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize); }
  setFilter(value: string) { this.filter = value; this.page = 0; }
  next() { if ((this.page + 1) * this.pageSize < this.filtered.length) this.page++; }
  previous() { this.page = Math.max(0, this.page - 1); }
  private async open(view: View) {
    const previous={view:this.view,data:this.data,page:this.page,filter:this.filter};
    this.stack.push(this.view); this.view=view; this.data=[]; this.page=0; this.filter="";
    try { await this.refresh(); }
    catch(error) { this.stack.pop(); this.view=previous.view; this.data=previous.data; this.page=previous.page; this.filter=previous.filter; throw error; }
  }
  async back() { const previous = this.stack.pop(); if (previous) { this.view = previous; this.page = 0; this.filter = ""; await this.refresh(); } }
  private async section(kind: typeof sections[number]) {
    const paths = { health: "/health", workers: "/stations", signals: "/signals", broadcasts: "/broadcasts", beacons: "/beacons", runs: "/runs?limit=200", images: `${this.client.registryPath()}/images`, deployments: `${this.client.registryPath()}/deployments`, environment: "/env" };
    await this.open({ kind, title: kind === "runs" ? "Runs (latest 200)" : kind, load: signal => kind === "owners" ? this.client.request("GET", this.client.connection.tenant ? "/tenant/execution" : "/execution", undefined, signal) : this.client.request("GET", paths[kind], undefined, signal) });
  }
  async select(index: number) {
    const selected = this.rows[index]; if (selected === undefined) throw new Error("Choose a visible row number.");
    const row = object(selected), name = string(row.name), id = string(row.id);
    if (this.view.selectRow) { await this.view.selectRow(row); return; }
    if (this.view.kind === "home") { await this.section(name as typeof sections[number]); return; }
    if (this.view.kind === "owners") {
      const owner = string(row.stationId); if (!owner) throw new Error("Execution owner is missing its identity.");
      const capabilities = object(row.capabilities);
      await this.open({ kind: "detail", parentKind: "owners", title: `Worker ${owner}`, owner, load: async () => [{ name: "sandboxes", available: capabilities.sandbox }, { name: "browsers", available: capabilities.browser }] }); return;
    }
    if (this.view.parentKind === "owners") {
      if (row.available !== true) throw new Error("This worker does not advertise that capability.");
      const owner = this.view.owner!, kind = name === "sandboxes" ? "sandboxes" : "browsers";
      await this.open({ kind, title: `${kind} · ${owner}`, owner, load: signal => this.client.execution(owner, kind === "sandboxes" ? "sandbox" : "browser", { method: "list" }, signal) }); return;
    }
    if (this.view.kind === "beacons") {
      await this.open({ kind: "instances", title: `Beacon ${name} instances`, beaconName: name, load: async signal => object(await this.client.request("GET", `/beacons/${encode(name)}`, undefined, signal)).instances ?? [] }); return;
    }
    const parentKind = this.view.kind, owner = this.view.owner, beaconName = this.view.beaconName;
    let resource = id || name, load: (signal?: AbortSignal) => Promise<unknown>;
    if (["signals", "broadcasts"].includes(parentKind)) load = signal => this.client.request("GET", `/${parentKind}/${encode(name)}`, undefined, signal);
    else if (parentKind === "runs") load = signal => this.client.request("GET", `/runs/${encode(id)}`, undefined, signal);
    else if (parentKind === "images") { resource = `${string(object(row.manifest).name)}@${string(row.digest)}`; load = signal => this.client.request("GET", `${this.client.registryPath()}/resolve?ref=${encode(resource)}`, undefined, signal); }
    else if (parentKind === "deployments") load = signal => this.client.request("GET", `${this.client.registryPath()}/deployments/${encode(id)}`, undefined, signal);
    else if (parentKind === "instances") load = signal => this.client.request("GET", `/beacons/${encode(beaconName!)}/instances/${encode(id)}`, undefined, signal);
    else if (parentKind === "sandboxes") load = signal => this.client.execution(owner!, "sandbox", { method: "get", id }, signal);
    else if (parentKind === "browsers") load = async signal => (await this.client.execution<unknown[]>(owner!, "browser", { method: "list" }, signal)).find(item => object(item).id === id) ?? { id, status: "closed" };
    else load = async () => selected;
    if (parentKind === "sandboxes" || parentKind === "browsers") { await this.executionResource(parentKind, owner!, resource, load); return; }
    if (parentKind === "images") { await this.imageResource(resource, load); return; }
    if (parentKind === "deployments") { await this.deploymentResource(resource, load); return; }
    await this.open({ kind: "detail", parentKind, title: `${parentKind} · ${resource}`, owner, resource, beaconName, load });
  }
  private boundAction(label: string, owner: string, primitive: "sandbox" | "browser", fixed: ExecutionRequest, input = false): TuiAction {
    return { label, target: `${this.client.url} · worker ${owner} · ${String(fixed.id ?? primitive)}`, input, perform: values => {
      if (Object.keys(values).some(key => Object.hasOwn(fixed,key) || ["stationId","owner","tenantId","tenant"].includes(key))) throw new Error("The selected resource and method cannot be overridden.");
      return this.client.execution(owner,primitive,{...values,...fixed});
    } };
  }
  private async executionResource(kind: "sandboxes" | "browsers", owner: string, resource: string, overview: View["load"]) {
    const primitive=kind==="sandboxes"?"sandbox":"browser";
    const call=(request:ExecutionRequest,signal?:AbortSignal)=>this.client.execution(owner,primitive,request,signal);
    const action=(label:string,request:ExecutionRequest,input=false)=>this.boundAction(label,owner,primitive,request,input);
    const detail=(title:string,load:View["load"],actions?:()=>TuiAction[])=>this.open({kind:"nested",title,owner,resource,load,customActions:actions});
    const list=async(title:string,load:View["load"],selectRow:(row:Record<string,unknown>)=>Promise<void>,actions?:()=>TuiAction[])=>this.open({kind:"nested",title,owner,resource,load,selectRow,customActions:actions});
    const commands=()=>this.receipts.get(`${owner}:${resource}`)?.filter(row=>row._type==="command")??[];
    const fileList=async(path=".",offset=0):Promise<void>=>list(`Files · ${path}`,async signal=>{
      const value=object(await call({method:"listFiles",id:resource,path,options:{offset,limit:200}},signal));
      return [...(Array.isArray(value.entries)?value.entries:[]),...(typeof value.nextOffset==="number"?[{name:"Next directory batch",_nextOffset:value.nextOffset}]:[])];
    },async row=>{
      if(typeof row._nextOffset==="number"){await fileList(path,row._nextOffset);return;}
      const selected=string(row.path);if(!selected)throw new Error("File entry has no path.");
      if(row.type==="directory"){await fileList(selected);return;}
      await detail(`File · ${selected}`,async()=>({...row,help:"Use station sandbox read/write for bounded binary transfer. File contents are not fetched by navigation."}),()=>[action("Remove selected file",{method:"removeFile",id:resource,path:selected})]);
    });
    const names=kind==="sandboxes"?["Overview","Files","Terminals","Commands (this TUI session)","Services"]:["Overview","Pages","Profiles (worker)","Recordings","Diagnostics","Audit","Checkpoints","Artifacts (this TUI session)"];
    await this.open({kind:"detail",parentKind:kind,title:`${kind} · ${resource}`,owner,resource,load:async()=>names.map(name=>({name})),selectRow:async row=>{
      switch(string(row.name)){
        case "Overview": await detail(`${kind} overview · ${resource}`,overview);return;
        case "Files": await fileList();return;
        case "Terminals": await list("Terminals",signal=>call({method:"terminals",id:resource},signal),async terminal=>{const terminalId=string(terminal.id);await detail(`Terminal · ${terminalId}`,signal=>call({method:"terminal",id:resource,terminalId},signal),()=>[action("Send terminal input",{method:"terminalInput",id:resource,terminalId},true),action("Resize terminal",{method:"resizeTerminal",id:resource,terminalId},true),action("Close terminal",{method:"closeTerminal",id:resource,terminalId})]);},()=>[action("Open terminal",{method:"openTerminal",id:resource},true)]);return;
        case "Commands (this TUI session)": await list("Commands · receipts created here; historical listing is unsupported",async()=>commands(),async command=>{const runId=string(command.id);await detail(`Command · ${runId}`,signal=>call({method:"command",id:resource,runId},signal),()=>[action("Cancel command",{method:"cancel",id:resource,runId})]);},()=>[action("Run command",{method:"exec",id:resource},true)]);return;
        case "Services": await list("Services",signal=>call({method:"services",id:resource},signal),async service=>{const serviceId=string(service.id);await detail(`Service · ${serviceId}`,signal=>call({method:"service",id:resource,serviceId},signal),()=>["stop","restart","remove"].map(verb=>action(`${verb} service`,{method:`${verb}Service`,id:resource,serviceId})));},()=>[action("Start service",{method:"startService",id:resource},true)]);return;
        case "Pages": await list("Browser pages",signal=>call({method:"execute",id:resource,command:{op:"pages"}},signal),async page=>{const pageId=string(page.id);await detail(`Page · ${pageId}`,async()=>page,()=>[action("Select page",{method:"execute",id:resource,command:{op:"selectPage",pageId}}),action("Close page",{method:"execute",id:resource,command:{op:"closePage",pageId}})]);},()=>[action("New page",{method:"execute",id:resource,command:{op:"newPage"}})]);return;
        case "Profiles (worker)": await list("Profiles · all profiles on this selected worker",signal=>call({method:"profiles"},signal),async profile=>{const id=string(profile.id);await detail(`Profile · ${id}`,async()=>profile,()=>[action("Delete profile",{method:"profileDelete",id}),action("Open profile",{method:"open",options:{profileId:id}})]);});return;
        case "Recordings": await list("Session recordings",async signal=>(await call({method:"recordings"},signal) as unknown[]).filter(item=>object(item).sessionId===resource),async recording=>{const id=string(recording.id);await list(`Recording · ${id} · frame metadata`,async signal=>object(await call({method:"recording",id},signal)).frames??[],async frame=>{await detail(`Frame · ${string(frame.id)}`,async()=>({...frame,help:"View playback in Station Dashboard; use browser API recordingFrame for image transfer."}));},()=>[action("Delete recording",{method:"recordingDelete",id})]);},()=>[action("Start recording",{method:"recordingStart",id:resource}),action("Stop recording",{method:"recordingStop",id:resource})]);return;
        case "Diagnostics": await detail("Browser diagnostics",signal=>call({method:"execute",id:resource,command:{op:"diagnostics",consoleText:false}},signal),()=>[action("Start trace",{method:"execute",id:resource,command:{op:"traceStart"}}),action("Stop trace",{method:"execute",id:resource,command:{op:"traceStop"}})]);return;
        case "Audit": await list("Session audit",async signal=>(await call({method:"audit"},signal) as unknown[]).filter(item=>object(item).sessionId===resource),async entry=>{await detail("Audit event",async()=>entry);});return;
        case "Checkpoints": await list("Session checkpoints",async signal=>(await call({method:"checkpoints"},signal) as unknown[]).filter(item=>object(item).sessionId===resource),async checkpoint=>{const id=string(checkpoint.id);await detail(`Checkpoint · ${id}`,async()=>checkpoint,()=>[action("Resume checkpoint",{method:"checkpointResume",id}),action("Delete checkpoint",{method:"checkpointDelete",id})]);},()=>[action("Create checkpoint",{method:"checkpoint",id:resource},true)]);return;
        case "Artifacts (this TUI session)": await list("Artifacts · receipts created here; server listing is unsupported",async()=>this.receipts.get(`${owner}:${resource}`)?.filter(row=>row._type==="artifact")??[],async artifact=>{await detail(`Artifact · ${string(artifact.id)}`,async()=>({...artifact,help:"Use station browser download-read for binary transfer."}),()=>[action("Delete artifact",{method:"execute",id:resource,command:{op:"downloadDelete",artifactId:string(artifact.id)}})]);});return;
      }
    }});
  }
  private async imageResource(reference:string,load:View["load"]){
    await this.open({kind:"detail",parentKind:"images",title:`Image · ${reference}`,resource:reference,load:async()=>[{name:"Manifest"},{name:"Versions"},{name:"Exports"}],selectRow:async row=>{
      const record=object(await load(this.signal)),manifest=object(record.manifest);
      if(row.name==="Versions"){await this.open({kind:"nested",title:`Versions · ${string(manifest.name)}`,load:async signal=>(await this.client.request<unknown[]>("GET",`${this.client.registryPath()}/images`,undefined,signal)).filter(item=>object(object(item).manifest).name===manifest.name),selectRow:async version=>this.imageResource(`${string(manifest.name)}@${string(version.digest)}`,signal=>this.client.request("GET",`${this.client.registryPath()}/resolve?ref=${encode(string(version.digest))}`,undefined,signal))});return;}
      if(row.name==="Exports"){await this.open({kind:"nested",title:"Image exports",load:async()=>manifest.exports??[],selectRow:async entry=>{await this.open({kind:"nested",title:`Export · ${string(entry.name)}`,load:async()=>entry,customActions:()=>[{label:"Run selected export",target:`${this.client.url} · ${reference} · ${string(entry.name)}`,input:true,perform:input=>this.client.request("POST",`${this.client.registryPath()}/run`,{reference,export:entry.name,input})}]});}});return;}
      await this.open({kind:"nested",title:"Image manifest",load});
    }});
  }
  private async deploymentResource(id:string,load:View["load"]){
    await this.open({kind:"detail",parentKind:"deployments",title:`Deployment · ${id}`,resource:id,load:async()=>[{name:"Overview"},{name:"Generations"},{name:"History"},{name:"Rollouts"}],selectRow:async row=>{
      if(row.name==="Overview"){await this.open({kind:"nested",title:"Deployment overview",load});return;}
      const key=string(row.name).toLowerCase();await this.open({kind:"nested",title:`Deployment ${key}`,load:async signal=>object(await load(signal))[key]??[],selectRow:async entry=>{await this.open({kind:"nested",title:`${key} · ${string(entry.id)}`,load:async()=>entry});}});
    }});
  }
  actions(): TuiAction[] {
    const v = this.view; if (v.customActions) return v.customActions();
    const target = `${this.client.url}${v.owner ? ` · worker ${v.owner}` : ""} · ${v.resource ?? v.title}`;
    const post = (label: string, path: string, body?: Record<string, unknown>): TuiAction => ({ label, target, input: body === undefined, perform: input => this.client.request("POST", path, body ?? input) });
    const execute = (label: string, primitive: "sandbox" | "browser", method: string, needsInput = false): TuiAction => ({ label, target, input: needsInput, perform: input => {
      if (["id","method","owner","stationId","tenantId","tenant"].some(key=>key in input)) throw new Error("The selected resource and method cannot be overridden.");
      const request: ExecutionRequest = { ...input, method, ...(v.resource ? { id: v.resource } : {}) };
      return this.client.execution(v.owner!, primitive, request);
    } });
    if (v.kind === "sandboxes") return [execute("Create sandbox", "sandbox", "create")];
    if (v.kind === "browsers") return [execute("Open browser", "browser", "open", true)];
    if (v.kind === "deployments") return [post("Stage deployment", `${this.client.registryPath()}/deployments`)];
    if (v.kind === "instances") return [post("Create beacon instance", `/beacons/${encode(v.beaconName!)}/instances`)];
    if (v.kind !== "detail") return [];
    switch (v.parentKind) {
      case "signals": return [{ label: "Run signal", target, input: true, perform: input => this.client.triggerSignal(v.resource!, input) }];
      case "broadcasts": return [{ label: "Run broadcast", target, input: true, perform: input => this.client.triggerBroadcast(v.resource!, input) }];
      case "runs": return [post("Cancel run", `/runs/${encode(v.resource!)}/cancel`, {})];
      case "instances": return ["start", "stop", "restart"].map(action => post(`${action} instance`, `/beacons/${encode(v.beaconName!)}/instances/${encode(v.resource!)}/${action}`, {}));
      case "images": return [post("Install image", `${this.client.registryPath()}/install`, { reference: v.resource! })];
      case "deployments": return ["activate", "rollback", "drain", "run"].map(action => post(`${action} deployment`, `${this.client.registryPath()}/deployments/${encode(v.resource!)}/${action}`));
      case "sandboxes": return [execute("Run command", "sandbox", "exec", true), execute("Destroy sandbox", "sandbox", "destroy")];
      case "browsers": return [execute("Browser command", "browser", "execute", true), execute("Start recording", "browser", "recordingStart"), execute("Close browser", "browser", "close")];
      default: return [];
    }
  }
  async mutate(index: number, input: Record<string, unknown>, confirmed: boolean) {
    if (!confirmed) return { cancelled: true };
    const action = this.actions()[index]; if (!action) throw new Error("Choose an available action.");
    const result = await action.perform(input);
    const row=object(result), key=`${this.view.owner}:${this.view.resource}`;
    if (typeof row.id === "string") {
      const saved=this.receipts.get(key)??[];
      const type=typeof row.mimeType==="string"?"artifact":typeof row.sandboxId==="string"&&"stdout" in row?"command":undefined;
      if(type){this.receipts.set(key,[...saved.filter(item=>item.id!==row.id),{...row,_type:type}].slice(-200));}
    }
    return result;
  }
}

/** Display-only protection for common named secrets; arbitrary text is not a secret detector. */
export function redactTuiValue(value:unknown,depth=0):unknown {
  if(depth>12)return "[depth limit]";
  if(typeof value==="string"){
    if(value.length<200_000&&/^[\s]*[\[{]/.test(value)){try{return redactTuiValue(JSON.parse(value),depth+1)}catch{}}
    return value.length>4000?`${value.slice(0,4000)}… [truncated]`:value;
  }
  if(Array.isArray(value))return value.slice(0,250).map(item=>redactTuiValue(item,depth+1));
  if(value&&typeof value==="object"){const record=value as Record<string,unknown>,namedSecret=record.secret===true||/(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i.test(String(record.key??record.name??""));return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==="value"&&namedSecret?"[redacted]":/^(?:base64|dataUrl)$/i.test(key)?"[binary omitted]":/(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key)/i.test(key)?"[redacted]":redactTuiValue(item,depth+1)]));}
  return value;
}

export async function tui(client: StationClient, context: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("station tui requires an interactive terminal.");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController(), stop = () => { controller.abort(); reader.close(); };
  process.once("SIGTERM", stop); reader.on("SIGINT", stop);
  let mode: "none" | "navigation" | "dialog" = "none", refreshing = false, dirty = false;
  let notice = "", live: LiveStatus = { state: "connecting", attempt: 0 };
  const model = new StationTuiModel(client, controller.signal);
  const render = () => {
    const width = Math.max(30, process.stdout.columns ?? 100);
    process.stdout.write(`\x1b[2J\x1b[HStation · ${clean(context)} · ${clean(client.url)} · ${client.connection.tenant ? "tenant" : "operator"}\n${clean(model.view.title)} · ${live.state}${live.reason ? ` · ${clean(live.reason)}` : ""}\n\n`);
    if (Array.isArray(model.data)) {
      model.rows.forEach((row, index) => process.stdout.write(`${index + 1}. ${clean(JSON.stringify(redactTuiValue(row))).slice(0, width - 8)}\n`));
      process.stdout.write(`\nPage ${model.page + 1} · ${model.filtered.length} matching rows · filter: ${clean(model.filter)}\n`);
    } else process.stdout.write(clean(JSON.stringify(redactTuiValue(model.data), null, 2)).slice(0, 18_000) + "\n");
    const actions = model.actions();
    if (actions.length) process.stdout.write(actions.map((action, index) => `a${index + 1} ${clean(action.label)}`).join(" · ") + "\n");
    if (notice) process.stdout.write(`\n${clean(notice).slice(0, 4000)}\n`);
    process.stdout.write("\nNumber: detail · b: back · r: refresh · n/p: page · f: filter · q: quit\n");
  };
  const redraw = () => { if (mode === "navigation" && !controller.signal.aborted) { render(); reader.prompt(true); } };
  const ask = async (prompt: string, navigation = false) => {
    mode = navigation ? "navigation" : "dialog";
    try { return await reader.question(prompt, { signal: controller.signal }); }
    finally { mode = "none"; }
  };
  const flush = async () => {
    // Don't reorder numbered rows beneath partially typed input or confirmation prompts.
    if (!dirty || refreshing || mode !== "navigation" || reader.line || controller.signal.aborted || live.reason === "identity_mismatch") return;
    dirty = false; refreshing = true;
    try {
      if (await model.refresh(() => mode === "navigation" && !reader.line && !controller.signal.aborted)) redraw();
      else dirty = true;
    }
    catch { if (!controller.signal.aborted) { notice = "Current view unavailable; read-only refresh will retry."; redraw(); } }
    finally { refreshing = false; }
  };
  const schedule = () => { dirty = true; };
  const refreshTimer = setInterval(() => { void flush(); }, 250);
  // Reconcile resources without event coverage, and tenant views without a global event grant.
  const pollTimer = setInterval(schedule, 5000);
  process.stdout.on("resize", redraw);
  const watching = watchStationEvents(client, { signal: controller.signal, onEvent: schedule, onStatus: status => { live = status; redraw(); } });
  process.stdout.write("\x1b[?1049h");
  try {
    await model.refresh();
    while (!controller.signal.aborted) {
      render();
      const actions = model.actions();
      let choice: string; try { choice = (await ask("› ", true)).trim(); } catch { break; }
      notice = "";
      if (choice === "q") break;
      try {
        if (choice === "r") await model.refresh();
        else if (choice === "b") await model.back();
        else if (choice === "n") model.next();
        else if (choice === "p") model.previous();
        else if (choice === "f") model.setFilter(await ask("Filter text (blank clears): "));
        else if (/^[1-9]\d*$/.test(choice)) await model.select(Number(choice) - 1);
        else if (/^a[1-9]\d*$/.test(choice)) {
          if (live.reason === "identity_mismatch" || live.reason === "incompatible_version") throw new Error("Daemon identity/version changed; reopen the connection before mutating resources.");
          const index = Number(choice.slice(1)) - 1, action = actions[index];
          if (!action) throw new Error("Choose an available action.");
          let input: Record<string, unknown> = {};
          if (action.input) {
            const path = (await ask("JSON input file (blank uses {}): ")).trim();
            if (path) { const parsed: unknown = JSON.parse((await boundedFile(path, 1024 * 1024)).toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Input file must contain a JSON object."); input = parsed as Record<string, unknown>; }
          }
          const confirmed = (await ask(`${clean(action.label)} on ${clean(action.target)}? Type yes: `)).trim() === "yes";
          if (controller.signal.aborted || live.reason === "identity_mismatch" || live.reason === "incompatible_version") throw new Error("Connection changed during confirmation; reopen it before mutating resources.");
          notice = JSON.stringify(redactTuiValue(await model.mutate(index, input, confirmed)), null, 2);
          if (confirmed) { try { await model.refresh(); } catch { /* Deleted resources remain inspectable until Back. */ } }
        }
      } catch (error) { if (controller.signal.aborted) break; notice = error instanceof Error ? error.message : "Operation failed."; }
    }
  } finally {
    stop(); clearInterval(refreshTimer); clearInterval(pollTimer); process.stdout.removeListener("resize", redraw);
    reader.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { await watching; }
    finally { process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l"); }
  }
}
