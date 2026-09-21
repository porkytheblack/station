import { beacon, type AnyBeacon } from 'station-beacon';
import { z } from 'station-signal';
import { FileImageRegistry, startImageBeacon, validateValue } from 'station-images';
import { createImageBackend, type ImageSignalConfig } from './shim.js';

/** Trusted supervisor shim; the uploaded executable never imports into this process. */
export function createImageBeacon(config: ImageSignalConfig): AnyBeacon {
  const schema = z.unknown().superRefine((value, ctx) => {
    try { validateValue(config.definition.configSchema, value); }
    catch { ctx.addIssue({ code: 'custom', message: 'Image beacon configuration does not match its schema.' }); }
  });
  return beacon(config.name).config(schema).startMode(config.definition.startMode ?? 'on-demand')
    .startupTimeout(12000).heartbeat(10000, { timeout: 35000 }).stopTimeout(5000).run(async ctx => {
      const store: Record<string, string> = {};
      for (const key of config.allowedEnv) if (ctx.environment?.[key] !== undefined) store[key] = ctx.environment[key];
      const session = await startImageBeacon({
        registry: new FileImageRegistry(config.registryRoot), reference: config.digest, exportName: config.definition.name,
        config: ctx.config, instanceId: ctx.instanceId, incarnation: String(ctx.incarnation), backend: createImageBackend(config.backend),
        requiredIsolation: config.backend.kind === 'trusted-local' ? 'trusted-host' : 'container',
        environment: { store, allowedKeys: config.allowedEnv },
        onEvent(frame) { if (frame.type === 'beacon:ready') ctx.ready(); if (frame.type === 'beacon:heartbeat') ctx.heartbeat(); },
        trigger: ({ alias, input, id }) => {
          if (!ctx.triggerDependency) throw new Error('No image dependency trigger supervisor');
          return ctx.triggerDependency(alias, input, id);
        },
      });
      ctx.onStop(() => session.stop());
      if (ctx.signal.aborted) await session.stop();
      let polling = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await session.ready;
        if (config.definition.mode === 'poll') {
          timer = setInterval(() => {
            if (polling || ctx.signal.aborted) return;
            polling = true;
            void session.poll().finally(() => { polling = false; }).catch(() => {});
          }, config.definition.pollIntervalMs ?? 1000);
        }
        await session.done;
      } finally { if (timer) clearInterval(timer); await session.stop(); }
    });
}
