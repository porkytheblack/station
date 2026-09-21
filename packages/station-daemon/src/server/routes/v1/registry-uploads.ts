import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ImageError, assertDigest, type ImageUploadManager } from "station-images";
import { requireScope } from "../../middleware/scope-guard.js";

/** Operator-only staging. Mount on the same API prefix as imageRegistryRoutes. */
export function imageUploadRoutes(uploads: ImageUploadManager) {
  const app = new Hono();
  app.use("/registry/uploads/*", requireScope("admin"));
  for (const path of ["/registry/uploads/*"]) {
    app.use(path, (c, next) => bodyLimit({ maxSize: c.req.method === "PATCH" ? uploads.maxChunkBytes : 4096, onError: ctx => ctx.json({ error: "payload_too_large" }, 413) })(c, next));
    app.use(path, async (c, next) => { c.header("Cache-Control", "private, no-store"); c.header("Upload-Max-Chunk-Bytes", String(uploads.maxChunkBytes)); await next(); });
  }
  app.onError((error, c) => {
    if (error instanceof ImageError) {
      const status = error.code === "not_found" ? 404 : error.code === "upload_expired" ? 410 : ["registry_busy", "upload_conflict", "upload_incomplete"].includes(error.code) ? 409 : ["blob_too_large", "chunk_too_large"].includes(error.code) ? 413 : ["upload_quota", "registry_quota"].includes(error.code) ? 507 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    if (error instanceof SyntaxError) return c.json({ error: "invalid_json" }, 400);
    return c.json({ error: "upload_unavailable", message: "Upload operation failed." }, 503);
  });
  app.post("/registry/uploads", async c => {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["digest", "size"].includes(key))) return c.json({ error: "invalid_upload" }, 400);
    assertDigest(body.digest);
    return c.json({ data: await uploads.create(body.digest, body.size) }, 201);
  });
  app.get("/registry/uploads/:id", async c => c.json({ data: await uploads.get(c.req.param("id")) }));
  app.patch("/registry/uploads/:id", async c => {
    const offset = c.req.header("Upload-Offset"); const digest = c.req.header("X-Chunk-SHA256");
    if (!offset || !/^(0|[1-9][0-9]{0,15})$/.test(offset)) return c.json({ error: "invalid_offset" }, 400);
    assertDigest(digest);
    const data = await uploads.append(c.req.param("id"), Number(offset), new Uint8Array(await c.req.arrayBuffer()), digest);
    c.header("Upload-Offset", String(data.offset)); return c.json({ data });
  });
  app.post("/registry/uploads/:id/commit", async c => c.json({ data: await uploads.commit(c.req.param("id")) }));
  app.delete("/registry/uploads/:id", async c => { await uploads.cancel(c.req.param("id")); return c.body(null, 204); });
  return app;
}
