import { ImageError, assertDigest, digestBytes, manifestDigest, validateManifest, type Digest, type ImageRecord, type ImageRegistry, type ImageUploadStatus } from "station-images";
import type { TenantRegistryExecution, TenantImageRunTarget } from "./tenants.js";
import { imageSignalName } from "../images/runtime.js";

export interface TenantRegistryWorkerGatewayOptions {
  tenantId: string;
  registry: ImageRegistry;
  url: string;
  token: string;
  stationId: string;
  requestTimeoutMs?: number;
  maxTransferBytes?: number;
}
interface Reply { status: number; data?: any; headers: Headers }
/** Fixed authenticated destination. Never construct these options from a tenant request. */
export function createTenantRegistryWorkerGateway(options: TenantRegistryWorkerGatewayOptions): TenantRegistryExecution {
  const { tenantId, registry, stationId, token } = options;
  const origin = new URL(options.url);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(tenantId) || typeof stationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/.test(stationId)) throw new Error("Invalid dedicated worker identity");
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw new Error("Dedicated worker must be a fixed HTTPS origin (HTTP is allowed only on loopback)");
  if (typeof token !== "string" || !token || token.length > 8192 || /[\r\n\0]/.test(token)) throw new Error("Invalid dedicated worker credential");
  const timeout = options.requestTimeoutMs ?? 30_000, maxBytes = options.maxTransferBytes ?? Math.min(registry.maxTotalBytes, 512 * 1024 * 1024);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 ** 3) throw new Error("Invalid dedicated worker request limits");
  let workerRegistryIdentity: string | undefined;
  const receipts = new Map<Digest, string>();
  let busy = false;
  async function request(path: string, method = "GET", body?: unknown, extra: Record<string,string> = {}, limit = 1024 * 1024): Promise<Reply> {
    let response: Response;
    try {
      response = await fetch(new URL(path, origin), { method, redirect: "error", signal: AbortSignal.timeout(timeout), headers: { authorization: `Bearer ${token}`, "x-station-image-tenant": tenantId, "x-station-image-worker": stationId, ...(workerRegistryIdentity ? {"x-station-image-registry":workerRegistryIdentity} : {}), ...(body instanceof Uint8Array ? {"content-type":"application/octet-stream"} : {"content-type":"application/json"}), ...extra }, ...(body === undefined ? {} : {body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body)}) });
    } catch { throw new ImageError("worker_unavailable", "Dedicated worker request failed"); }
    if (!response.ok) { await response.body?.cancel(); return {status:response.status,headers:response.headers}; }
    if (response.status === 204) { await response.body?.cancel(); return {status:204,headers:response.headers}; }
    const length = response.headers.get("content-length");
    if (length && Number(length) > limit) { await response.body?.cancel(); throw new ImageError("worker_limit", "Dedicated worker response exceeds its limit"); }
    const reader = response.body?.getReader(); if (!reader) throw new ImageError("worker_invalid", "Missing dedicated worker response");
    const chunks: Uint8Array[] = []; let size=0;
    try { while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new ImageError("worker_limit","Dedicated worker response exceeds its limit");chunks.push(value);} }
    finally { await reader.cancel(); reader.releaseLock(); }
    let data: any; try {data=JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data;} catch {throw new ImageError("worker_invalid","Invalid dedicated worker response");}
    return {status:response.status,data,headers:response.headers};
  }
  const expect = (response: Reply, statuses: number[] = [200,201]): Reply => { if(!statuses.includes(response.status))throw new ImageError("worker_unavailable",`Dedicated worker returned HTTP ${response.status}`);return response; };
  async function identity() {
    const info=expect(await request("/api/v1/info")).data;
    if(!info||info.protocol!=="station.api/v1"||typeof info.version!=="string"||!/^3\./.test(info.version)||info.role!=="station"||info.stationId!==stationId||info.imageExecution?.tenantId!==tenantId||!["container","vm"].includes(info.imageExecution?.isolation)||typeof info.imageExecution?.registryIdentity!=="string"||!/^[a-zA-Z0-9:._-]{1,256}$/.test(info.imageExecution.registryIdentity))throw new ImageError("worker_identity_mismatch","Dedicated worker identity or isolation does not match configuration");
    if(workerRegistryIdentity!==undefined&&workerRegistryIdentity!==info.imageExecution.registryIdentity)throw new ImageError("worker_identity_mismatch","Dedicated worker storage identity changed");
    workerRegistryIdentity=info.imageExecution.registryIdentity;
  }
  async function mutate(path:string,method:string,body?:unknown,headers?:Record<string,string>){await identity();return expect(await request(path,method,body,headers),method==="DELETE"?[204]:[200,201]);}
  function status(value: unknown, digest: Digest, size: number): ImageUploadStatus {
    const upload=value as ImageUploadStatus;
    if(!upload||typeof upload.id!=="string"||!/^[a-f0-9-]{36}$/.test(upload.id)||upload.digest!==digest||upload.size!==size||!Number.isSafeInteger(upload.offset)||upload.offset<0||upload.offset>size||!["open","committed"].includes(upload.state)||!Number.isSafeInteger(upload.expiresAt))throw new ImageError("worker_invalid","Invalid worker upload status");
    return upload;
  }
  async function transfer(digest:Digest,bytes:Buffer){
    let id=receipts.get(digest),reply:Reply|undefined;
    if(id){reply=await request(`/api/v1/registry/uploads/${id}`);if([404,410].includes(reply.status)){receipts.delete(digest);id=undefined;reply=undefined;}else expect(reply);}
    if(!id){if(receipts.size>=128)throw new ImageError("worker_limit","Too many unfinished worker uploads");reply=await mutate("/api/v1/registry/uploads","POST",{digest,size:bytes.length});const upload=status(reply.data,digest,bytes.length);id=upload.id;receipts.set(digest,id);}
    let upload=status(reply!.data,digest,bytes.length);
    const advertised=reply!.headers.get("Upload-Max-Chunk-Bytes"),chunkSize=advertised===null?1024*1024:Number(advertised);
    if(!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>8*1024*1024)throw new ImageError("worker_invalid","Invalid worker chunk limit");
    while(upload.offset<bytes.length){const offset=upload.offset,chunk=bytes.subarray(offset,Math.min(bytes.length,offset+chunkSize));reply=await mutate(`/api/v1/registry/uploads/${id}`,"PATCH",chunk,{"Upload-Offset":String(offset),"X-Chunk-SHA256":digestBytes(chunk)});upload=status(reply.data,digest,bytes.length);if(upload.offset!==offset+chunk.length)throw new ImageError("worker_invalid","Worker acknowledged an incorrect upload offset");}
    upload=status((await mutate(`/api/v1/registry/uploads/${id}/commit`,"POST")).data,digest,bytes.length);
    if(upload.state!=="committed")throw new ImageError("worker_invalid","Worker did not commit the artifact");
    await mutate(`/api/v1/registry/uploads/${id}`,"DELETE");receipts.delete(digest);
  }
  async function copy(reference: string): Promise<Digest> {
    assertDigest(reference);
    const records:ImageRecord[]=[],seen=new Set<string>(),pending=new Set<string>();let total=0;
    const artifacts=new Set<Digest>();
    async function visit(ref:string,depth:number){
      if(depth>32)throw new ImageError("dependency_limit","Worker image dependency closure exceeds its limit");
      const record=await registry.resolve(ref);if(seen.has(record.digest))return;if(seen.size+pending.size>=128)throw new ImageError("dependency_limit","Worker image dependency closure exceeds its limit");if(pending.has(record.digest))throw new ImageError("invalid_dependency","Cyclic image dependency");pending.add(record.digest);
      for(const dependency of Object.values(record.manifest.dependencies??{}))await visit(dependency.image,depth+1);
      for(const artifact of record.manifest.artifacts)if(!artifacts.has(artifact.digest)){artifacts.add(artifact.digest);total+=artifact.size;if(total>maxBytes)throw new ImageError("worker_limit","Worker artifact transfer exceeds its byte budget");}
      pending.delete(record.digest);seen.add(record.digest);records.push(record);
    }
    await visit(reference,0);await identity();
    const copiedArtifacts=new Set<Digest>();
    for(const record of records){
      const existing=await request(`/api/v1/registry/resolve?ref=${encodeURIComponent(record.digest)}`);
      if(existing.status===200){validateManifest(existing.data?.manifest);if(existing.data.digest!==record.digest||manifestDigest(existing.data.manifest)!==record.digest)throw new ImageError("worker_invalid","Worker returned the wrong immutable manifest");continue;}
      if(existing.status!==404)expect(existing);
      for(const artifact of record.manifest.artifacts){if(copiedArtifacts.has(artifact.digest))continue;const bytes=await registry.getBlob(artifact.digest);if(bytes.length!==artifact.size)throw new ImageError("digest_mismatch","Source artifact size mismatch");await transfer(artifact.digest,bytes);copiedArtifacts.add(artifact.digest);}
      const published=(await mutate("/api/v1/registry/images","POST",record.manifest)).data;
      if(published?.digest!==record.digest)throw new ImageError("worker_invalid","Worker published the wrong manifest identity");
    }
    return reference;
  }
  async function inspectTarget(target: TenantImageRunTarget) {
    assertDigest(target.reference);
    if (!target || !["signal", "broadcast", "beacon"].includes(target.kind) || typeof target.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,254}$/.test(target.id)) throw new ImageError("invalid_invocation", "Invalid image execution identity");
    const record = await registry.resolve(target.reference);
    const definition = record.manifest.exports.find(item => item.name === target.export && item.kind === target.kind);
    if (!definition) throw new ImageError("not_found", "Image export not found");
    const name = imageSignalName(record.digest, definition.name), id = encodeURIComponent(target.id);
    const path = target.kind === "signal" ? `/api/v1/runs/${id}` : target.kind === "broadcast" ? `/api/v1/broadcast-runs/${id}` : `/api/v1/beacons/${encodeURIComponent(name)}/instances/${id}`;
    await identity();
    const response = await request(path, "GET", undefined, {}, 8 * 1024 * 1024);
    if (response.status === 404) throw new ImageError("not_found", "Image execution not found");
    const data = expect(response).data;
    const actualName = target.kind === "signal" ? data?.signalName : target.kind === "broadcast" ? data?.broadcastName : data?.beaconName;
    let requiredStationId = data?.requiredStationId;
    if (target.kind === "broadcast") {
      try { requiredStationId = JSON.parse(data?.definitionSnapshot).requiredStationId; }
      catch { throw new ImageError("not_found", "Broadcast execution lacks a verified placement snapshot"); }
    }
    if (!data || data.id !== target.id || actualName !== name || requiredStationId !== stationId || data.stationId !== undefined && data.stationId !== null && data.stationId !== stationId) throw new ImageError("not_found", "Image execution does not belong to this worker and export");
    // The operator API includes controller internals. A tenant receives only
    // execution state, never a fencing token, process path or saved plan.
    const visible = ['id', 'signalName', 'broadcastName', 'beaconName', 'kind', 'input', 'output', 'error', 'status', 'attempts', 'maxAttempts', 'timeout', 'createdAt', 'startedAt', 'completedAt', 'nextRunAt', 'lastRunAt', 'stationId', 'requiredStationId', 'scheduleId', 'scheduledFor', 'desiredState', 'incarnation', 'restartCount', 'config', 'readyAt', 'lastHeartbeatAt', 'lastExitAt', 'lastExitReason', 'lastError', 'nextRestartAt', 'updatedAt', 'label', 'origin'];
    return { data: Object.fromEntries(visible.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])), path };
  }
  async function transition(target: TenantImageRunTarget, action: "cancel" | "restart") {
    if (action === "restart" && target.kind !== "beacon") throw new ImageError("invalid_invocation", "Only beacon instances can be restarted");
    const { path } = await inspectTarget(target);
    await identity();
    const response = await request(`${path}/${action === "cancel" && target.kind === "beacon" ? "stop" : action}`, "POST", {});
    if (response.status === 404) throw new ImageError("not_found", "Image execution not found");
    if (response.status === 400 || response.status === 409) throw new ImageError("invalid_state", "Image execution cannot transition in its current state");
    expect(response);
    return { id: target.id, kind: target.kind, action: action === 'cancel' && target.kind === 'beacon' ? 'stop' : action, accepted: true };
  }
  async function exclusive<T>(work:()=>Promise<T>):Promise<T>{if(busy)throw new ImageError("registry_busy","Dedicated worker transfer is busy; retry later");busy=true;try{return await work();}finally{busy=false;}}
  return {
    tenantId,registryIdentity:registry.identity,dedicated:true,isolation:"container",
    inspect:target=>exclusive(async()=>(await inspectTarget(target)).data),
    cancel:target=>exclusive(()=>transition(target,"cancel")),
    restart:target=>exclusive(()=>transition(target,"restart")),
    install:reference=>exclusive(async()=>{const digest=await copy(reference);return(await mutate("/api/v1/registry/install","POST",{reference:digest})).data;}),
    run:(reference,exportName,input)=>exclusive(async()=>{const digest=await copy(reference);return(await mutate("/api/v1/registry/run","POST",{reference:digest,export:exportName,input,stationId})).data;}),
  };
}
