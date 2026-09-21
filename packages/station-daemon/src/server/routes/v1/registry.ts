import type { ImageController } from "../../../images/controller.js";
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { FileImageRegistry, ImageError, validateManifest, assertDigest, type ImageManifest, importImage, type ImageSource } from 'station-images';
import { requireScope } from '../../middleware/scope-guard.js';

/** Registry is operator-only. Tenant execution keys never grant artifact access. */
export function imageRegistryRoutes(registry: FileImageRegistry, source?: ImageSource, controller?: ImageController) {
  const app = new Hono();
  app.use('/registry/*', requireScope('admin'));
  app.use('/registry/*', bodyLimit({ maxSize: registry.maxBlobBytes, onError: c => c.json({ error: 'payload_too_large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof ImageError) {
      const status = error.code === 'not_found' ? 404 : error.code === 'registry_busy' || error.code === 'immutable_conflict' ? 409 : error.code === 'registry_quota' ? 507 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
    return c.json({ error: 'registry_unavailable', message: 'Registry operation failed.' }, 503);
  });
  app.post('/registry/install', async c => {
    if (!controller) return c.json({ error: 'image_execution_not_configured' }, 409);
    const body = await c.req.json();
    if (!body || typeof body.reference !== 'string' || Object.keys(body).some(key => key !== 'reference')) return c.json({ error: 'invalid_reference' }, 400);
    return c.json({ data: await controller.install(body.reference) }, 201);
  });
  app.post('/registry/run', async c => {
    if (!controller) return c.json({ error: 'image_execution_not_configured' }, 409);
    const body = await c.req.json();
    if (!body || typeof body.reference !== 'string' || typeof body.export !== 'string' || Object.keys(body).some(key => !['reference', 'export', 'input', 'stationId'].includes(key))) return c.json({ error: 'invalid_reference' }, 400);
    return c.json({ data: await controller.run(body.reference, body.export, body.input ?? {}, body.stationId) }, 201);
  });
  app.post('/registry/pull', async c => {
    if (!source) return c.json({ error: 'upstream_not_configured' }, 409);
    const body = await c.req.json();
    if (!body || typeof body.reference !== 'string' || Object.keys(body).some(key => key !== 'reference')) return c.json({ error: 'invalid_reference' }, 400);
    return c.json({ data: await importImage(registry, body.reference, source) }, 201);
  });
  app.get('/registry/images', async c => c.json({ data: await registry.list() }));
  app.get('/registry/resolve', async c => c.json({ data: await registry.resolve(c.req.query('ref') ?? '') }));
  app.put('/registry/blobs/:digest', async c => {
    const digest = c.req.param('digest'); assertDigest(digest);
    return c.json({ data: await registry.putBlob(new Uint8Array(await c.req.arrayBuffer()), digest) }, 201);
  });
  app.get('/registry/blobs/:digest', async c => {
    const digest = c.req.param('digest'); assertDigest(digest);
    const bytes = await registry.getBlob(digest);
    c.header('Content-Type', 'application/octet-stream');
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(bytes));
  });
  app.post('/registry/images', async c => {
    const manifest: unknown = await c.req.json(); validateManifest(manifest);
    return c.json({ data: await registry.publish(manifest as ImageManifest) }, 201);
  });
  app.put('/registry/tags', async c => {
    const body = await c.req.json();
    if (!body || typeof body.name !== 'string' || typeof body.tag !== 'string') return c.json({ error: 'invalid_tag' }, 400);
    assertDigest(body.digest);
    await registry.setTag(body.name, body.tag, body.digest);
    return c.json({ data: { name: body.name, tag: body.tag, digest: body.digest } });
  });
  return app;
}
