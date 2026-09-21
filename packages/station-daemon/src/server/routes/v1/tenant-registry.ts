import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ImageError, assertDigest, validateManifest, validateValue } from "station-images";
import { RegistryTenantAccess, type RegistryPermission, type TenantImageRegistryConfig, type TenantImageRunTarget } from "../../../registry/tenants.js";

/** Fixed tenant namespaces. Authentication must have resolved a live key before this router. */
export function tenantImageRegistryRoutes(config: TenantImageRegistryConfig, excludedRegistryIdentities: readonly string[] = []) {
  const access = new RegistryTenantAccess(config, excludedRegistryIdentities);
  const app = new Hono();
  const identity = (c: Context) => access.resolve(c.get("authType"), c.get("scopes"), c.get("apiKeyId"));
  const rate=config.limits?.requestsPerSecond??30,burst=config.limits?.burst??60,perTenant=config.limits?.maxInFlightPerTenant??4,total=config.limits?.maxInFlight??64;
  const buckets=new Map([...access.namespaces.keys()].map(id=>[id,{tokens:burst,updated:performance.now(),active:0}]));let active=0;
  for(const path of ["/tenant/registry/*"]){
    app.use(path,async(c: Context,next)=>{
      c.header("Cache-Control","private, no-store");
      const grant=identity(c);if(!grant)return c.json({error:c.get("authType")==="none"||!c.get("authType")?"unauthorized":"forbidden"},c.get("authType")==="none"||!c.get("authType")?401:403);
      const bucket=buckets.get(grant.tenantId)!,now=performance.now();bucket.tokens=Math.min(burst,bucket.tokens+Math.max(0,now-bucket.updated)*rate/1000);bucket.updated=now;
      if(bucket.tokens<1||bucket.active>=perTenant||active>=total){c.header("Retry-After","1");return c.json({error:"capacity"},429);}
      bucket.tokens--;bucket.active++;active++;try{await next();}finally{bucket.active--;active--;}
    });
    app.use(path,bodyLimit({maxSize:8*1024*1024,onError:c=>c.json({error:"payload_too_large"},413)}));
  }
  const permit=(permission:RegistryPermission,handler:(c:Context,namespace:NonNullable<ReturnType<typeof identity>>["namespace"])=>Promise<Response>)=>async(c:Context)=>{
    const grant=identity(c);if(!grant||!grant.permissions.has(permission))return c.json({error:"forbidden"},403);return handler(c,grant.namespace);
  };
  const body=async(c:Context,fields:string[])=>{const value=await c.req.json();if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!fields.includes(key)))throw new ImageError("invalid_request","Unexpected request fields");return value;};
  app.onError((error,c)=>{
    if(error instanceof ImageError){const status=error.code==="not_found"?404:error.code==="upload_expired"?410:["registry_busy","immutable_conflict","upload_conflict","upload_incomplete","invalid_state"].includes(error.code)?409:["blob_too_large","chunk_too_large"].includes(error.code)?413:["registry_quota","upload_quota"].includes(error.code)?507:400;return c.json({error:error.code,message:error.message},status);}
    if(error instanceof SyntaxError)return c.json({error:"invalid_json"},400);
    return c.json({error:"registry_unavailable",message:"Tenant registry operation failed."},503);
  });
  app.get("/tenant/registry",async c=>{const grant=identity(c)!;return c.json({data:{tenantId:grant.tenantId,permissions:[...grant.permissions],executionConfigured:Boolean(grant.namespace.execution),uploadsConfigured:Boolean(grant.namespace.uploads)}});});
  app.get("/tenant/registry/images",permit("read",async(c,ns)=>c.json({data:await ns.registry.list()})));
  app.get("/tenant/registry/resolve",permit("read",async(c,ns)=>c.json({data:await ns.registry.resolve(c.req.query("ref")??"")})));
  app.get("/tenant/registry/blobs/:digest",permit("read",async(c,ns)=>{const digest=c.req.param("digest");assertDigest(digest);c.header("Content-Type","application/octet-stream");c.header("X-Content-Type-Options","nosniff");return c.body(new Uint8Array(await ns.registry.getBlob(digest)));}));
  app.put("/tenant/registry/blobs/:digest",permit("publish",async(c,ns)=>{const digest=c.req.param("digest");assertDigest(digest);return c.json({data:await ns.registry.putBlob(new Uint8Array(await c.req.arrayBuffer()),digest)},201);}));
  app.post("/tenant/registry/images",permit("publish",async(c,ns)=>{const manifest=await c.req.json();validateManifest(manifest);return c.json({data:await ns.registry.publish(manifest)},201);}));
  app.put("/tenant/registry/tags",permit("publish",async(c,ns)=>{const value=await body(c,["name","tag","digest"]);if(typeof value.name!=="string"||typeof value.tag!=="string")throw new ImageError("invalid_tag","Expected image name and tag");assertDigest(value.digest);await ns.registry.setTag(value.name,value.tag,value.digest);return c.json({data:value});}));
  app.post("/tenant/registry/install",permit("activate",async(c,ns)=>{if(!ns.execution)return c.json({error:"tenant_execution_not_configured"},409);const value=await body(c,["reference"]);const record=await ns.registry.resolve(value.reference);return c.json({data:await ns.execution.install(record.digest)},201);}));
  app.post("/tenant/registry/run",permit("invoke",async(c,ns)=>{
    if(!ns.execution)return c.json({error:"tenant_execution_not_configured"},409);
    const value=await body(c,["reference","export","input"]),record=await ns.registry.resolve(value.reference),definition=record.manifest.exports.find(entry=>entry.name===value.export);
    if(!definition)throw new ImageError("not_found","Image export not found");validateValue(definition.kind==="beacon"?definition.configSchema:definition.inputSchema,value.input??{});
    return c.json({data:await ns.execution.run(record.digest,value.export,value.input??{})},201);
  }));
  const runTarget = (c: Context, value: Record<string, unknown>): TenantImageRunTarget => {
    const kind = c.req.param("kind");
    if (!["signal", "broadcast", "beacon"].includes(kind) || typeof value.export !== "string" || Object.keys(value).some(key => !["reference", "export"].includes(key))) throw new ImageError("invalid_invocation", "Invalid image execution target");
    assertDigest(value.reference);
    return { reference: value.reference, export: value.export, kind: kind as TenantImageRunTarget["kind"], id: c.req.param("id") };
  };
  app.get("/tenant/registry/runs/:kind/:id", permit("read", async (c, ns) => {
    if (!ns.execution?.inspect) return c.json({error:"tenant_lifecycle_not_configured"},409);
    return c.json({data:await ns.execution.inspect(runTarget(c,c.req.query()))});
  }));
  app.post("/tenant/registry/runs/:kind/:id/cancel", permit("invoke", async (c, ns) => {
    if (!ns.execution?.cancel) return c.json({error:"tenant_lifecycle_not_configured"},409);
    return c.json({data:await ns.execution.cancel(runTarget(c,await body(c,["reference","export"])))});
  }));
  app.post("/tenant/registry/runs/:kind/:id/restart", permit("invoke", async (c, ns) => {
    if (!ns.execution?.restart) return c.json({error:"tenant_lifecycle_not_configured"},409);
    const target=runTarget(c,await body(c,["reference","export"]));
    if(target.kind!=="beacon")throw new ImageError("invalid_invocation","Only beacon instances can be restarted");
    return c.json({data:await ns.execution.restart(target)});
  }));
  app.post("/tenant/registry/uploads",permit("publish",async(c,ns)=>{if(!ns.uploads)return c.json({error:"uploads_not_configured"},409);const value=await body(c,["digest","size"]);assertDigest(value.digest);c.header("Upload-Max-Chunk-Bytes",String(ns.uploads.maxChunkBytes));return c.json({data:await ns.uploads.create(value.digest,value.size)},201);}));
  app.get("/tenant/registry/uploads/:id",permit("publish",async(c,ns)=>{if(!ns.uploads)return c.json({error:"uploads_not_configured"},409);c.header("Upload-Max-Chunk-Bytes",String(ns.uploads.maxChunkBytes));return c.json({data:await ns.uploads.get(c.req.param("id"))});}));
  app.patch("/tenant/registry/uploads/:id",permit("publish",async(c,ns)=>{
    if(!ns.uploads)return c.json({error:"uploads_not_configured"},409);const offset=c.req.header("Upload-Offset"),digest=c.req.header("X-Chunk-SHA256");
    if(!offset||!/^(0|[1-9][0-9]{0,15})$/.test(offset))throw new ImageError("invalid_offset","Expected an integer Upload-Offset");assertDigest(digest);
    const data=await ns.uploads.append(c.req.param("id"),Number(offset),new Uint8Array(await c.req.arrayBuffer()),digest);c.header("Upload-Offset",String(data.offset));return c.json({data});
  }));
  app.post("/tenant/registry/uploads/:id/commit",permit("publish",async(c,ns)=>{if(!ns.uploads)return c.json({error:"uploads_not_configured"},409);return c.json({data:await ns.uploads.commit(c.req.param("id"))});}));
  app.delete("/tenant/registry/uploads/:id",permit("publish",async(c,ns)=>{if(!ns.uploads)return c.json({error:"uploads_not_configured"},409);await ns.uploads.cancel(c.req.param("id"));return c.body(null,204);}));
  return app;
}
