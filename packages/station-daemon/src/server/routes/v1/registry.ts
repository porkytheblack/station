import type { ImageController } from "../../../images/controller.js";
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type ImageRegistry, ImageError, validateManifest, assertDigest, type ImageManifest, importImage, type ImageSource } from 'station-images';
import { requireScope } from '../../middleware/scope-guard.js';

/** Registry is operator-only. Tenant execution keys never grant artifact access. */
export function imageRegistryRoutes(registry: ImageRegistry, source?: ImageSource, controller?: ImageController) {
  const app = new Hono();
  app.use('/registry/*', requireScope('admin'));
  app.use('/registry/*', bodyLimit({ maxSize: registry.maxBlobBytes, onError: c => c.json({ error: 'payload_too_large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof ImageError) {
      const status = error.code === 'not_found' ? 404 : ['registry_busy', 'immutable_conflict', 'deployment_busy', 'revision_conflict', 'deployment_inactive'].includes(error.code) ? 409 : error.code === 'registry_quota' ? 507 : 400;
      return c.json({ error: error.code, message: error.message }, status);
    }
    if (error instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
    return c.json({ error: 'registry_unavailable', message: 'Registry operation failed.' }, 503);
  });
  app.get('/registry/generations', async c => c.json({ data: await controller?.generations() ?? [] }));
  app.get('/registry/preparations', async c => c.json({ data: controller?.preparations?.list() ?? [] }));
  if (controller) {
    app.get('/registry/deployments', async c => c.json({ data: await controller.deployments.list() }));
    app.get('/registry/deployments/:id', async c => c.json({ data: await controller.deployments.get(c.req.param('id')) }));
    app.post('/registry/deployments', async c => {
      const body = await c.req.json();
      if (!body || typeof body.name !== 'string' || typeof body.reference !== 'string' || Object.keys(body).some(k => !['name', 'reference', 'aliases', 'stationId', 'bindings', 'invocationEnv'].includes(k))) return c.json({ error: 'invalid_deployment' }, 400);
      return c.json({ data: await controller.stageDeployment(body.name, body.reference, body.aliases, body.stationId, body.bindings, body.invocationEnv) }, 201);
    });
    for (const action of ['activate', 'rollback', 'drain'] as const) app.post(`/registry/deployments/:id/${action}`, async c => {
      const body = await c.req.json();
      if (!body || !Number.isSafeInteger(body.expectedRevision) || action !== 'drain' && typeof body.generation !== 'string' || Object.keys(body).some(k => !['generation', 'expectedRevision'].includes(k))) return c.json({ error: 'invalid_deployment' }, 400);
      return c.json({ data: await controller.changeDeployment(c.req.param('id'), body.expectedRevision, action, body.generation) });
    });
    app.post('/registry/deployments/:id/run', async c => {
      const body = await c.req.json();
      if (!body || typeof body.alias !== 'string' || Object.keys(body).some(k => !['alias', 'input', 'environment'].includes(k))) return c.json({ error: 'invalid_deployment' }, 400);
      return c.json({ data: await controller.runDeployment(c.req.param('id'), body.alias, body.input ?? {}, body.environment) }, 201);
    });
    app.post('/registry/deployments/:id/rollout', async c => {
      const body = await c.req.json();
      if (!body || typeof body.operationId !== 'string' || typeof body.sourceInstance !== 'string' || typeof body.generation !== 'string' || typeof body.alias !== 'string' || !Number.isSafeInteger(body.expectedRevision) || Object.keys(body).some(k => !['operationId', 'sourceInstance', 'generation', 'alias', 'expectedRevision'].includes(k))) return c.json({ error: 'invalid_rollout' }, 400);
      return c.json({ data: await controller.rolloutBeacon(c.req.param('id'), body) }, 202);
    });
  }
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
