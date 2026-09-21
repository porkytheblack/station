import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SignalRunner } from 'station-signal';
import type { BroadcastRunner } from 'station-broadcast';
import type { BeaconRunner } from 'station-beacon';
import { importImage, ImageError, selectArtifact, type ImageRegistry, type ImageSource, type ImageRecord, type ImageExport } from 'station-images';
import { ImageRuntime, imageSignalName, type ImageRuntimeOptions, type InstalledImage } from './runtime.js';
import { createImageBackend } from './shim.js';
import { createImageBeacon } from './beacon-shim.js';

export type DaemonImageExecution = Pick<ImageRuntimeOptions, 'backend' | 'allowedEnv'>;
export interface ImageControllerOptions extends DaemonImageExecution {
  registry: ImageRegistry;
  cacheDir?: string;
  source?: ImageSource;
  signalRunner: SignalRunner;
  broadcastRunner?: BroadcastRunner;
  beaconRunner?: BeaconRunner;
  stateDir: string;
  stationId?: string;
  canTarget?: (stationId: string, signalName: string) => Promise<boolean>;
}
/** Installs controlled shims into the existing runners; digests become queue identity. */
export class ImageController {
  private readonly runtime: ImageRuntime;
  private readonly exports = new Map<string, { image: ImageRecord; definition: ImageExport }>();
  private readonly beacons = new Set<string>();
  private readonly synced = new Set<string>();
  constructor(private readonly options: ImageControllerOptions) {
    this.runtime = new ImageRuntime(options);
    options.beaconRunner?.setDependencyTrigger(async request => {
      const source = this.exports.get(request.beaconName);
      const dependency = source?.image.manifest.dependencies?.[request.alias];
      if (!source || !dependency) throw new ImageError('dependency_denied', 'Undeclared image dependency');
      const target = await this.runtime.cache.resolve(dependency.image);
      const name = imageSignalName(target.digest, dependency.export);
      const key = `beacon:${request.instanceId}:${request.incarnation}:${request.requestId}`;
      if (dependency.kind === 'signal') return options.signalRunner.triggerSignal(name, request.input, undefined, { idempotencyKey: key });
      if (!options.broadcastRunner) throw new ImageError('unavailable', 'Broadcast queue is unavailable');
      return options.broadcastRunner.trigger(name, request.input, { idempotencyKey: key });
    });
  }
  targetKind(name: string): 'signal' | 'broadcast' | 'beacon' | undefined { return this.exports.get(name)?.definition.kind; }
  async sync(catalog: ImageRecord[]): Promise<void> {
    const target = createImageBackend(this.options.backend).target;
    for (const record of catalog) {
      if (this.synced.has(record.digest)) continue;
      try {
        selectArtifact(record.manifest, target);
        // Dependencies must fit this worker too. An incompatible closure does
        // not prevent unrelated compatible images later in the catalog.
        await this.install(record.digest);
        this.synced.add(record.digest);
      } catch (error) {
        if (error instanceof ImageError && error.code === 'incompatible_target') continue;
        throw error; // Corruption and denied grants are operator-visible failures.
      }
    }
  }
  async restore(): Promise<void> { for (const installation of await this.runtime.restore()) await this.wire(installation); }
  async install(reference: string) {
    let installed: InstalledImage;
    try { installed = await this.runtime.install(reference); }
    catch (error) {
      if (!(error instanceof ImageError) || error.code !== 'not_found' || !this.options.source) throw error;
      const pulled = await importImage(this.options.registry, reference, this.options.source);
      installed = await this.runtime.install(pulled.digest);
    }
    await this.wire(installed);
    return { image: installed.image, exports: installed.image.manifest.exports.map(definition => ({ ...definition, registeredName: imageSignalName(installed.image.digest, definition.name) })) };
  }
  private async wire(installed: InstalledImage): Promise<void> {
    for (const image of installed.images) for (const definition of image.manifest.exports) {
      const name = imageSignalName(image.digest, definition.name);
      this.exports.set(name, { image, definition });
      if (definition.kind === 'broadcast' && this.options.broadcastRunner) {
        const dependencies: Record<string, string> = Object.create(null);
        for (const local of image.manifest.exports) if (local.kind === "signal") dependencies[local.name] = imageSignalName(image.digest, local.name);
        for (const [alias, dep] of Object.entries(image.manifest.dependencies ?? {})) {
          if (dep.kind !== 'signal') continue;
          const target = await this.runtime.cache.resolve(dep.image);
          dependencies[alias] = imageSignalName(target.digest, dep.export);
        }
        this.options.broadcastRunner.registerPlanner(name, { signalName: name, dependencies });
      }
      if (definition.kind === 'beacon' && this.options.beaconRunner && !this.beacons.has(name)) {
        const config = { registryRoot: this.runtime.cache.root, digest: image.digest, name, definition, backend: this.options.backend, allowedEnv: [...(this.options.allowedEnv ?? [])] };
        const path = join(this.options.stateDir, `${name}-beacon.mjs`);
        await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
        const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
        await writeFile(path, `import { createImageBeacon } from ${JSON.stringify(new URL(`./beacon-shim${extension}`, import.meta.url).href)};\nexport default createImageBeacon(${JSON.stringify(config)});\n`, { mode: 0o600 });
        await this.options.beaconRunner.install(createImageBeacon(config), path);
        this.beacons.add(name);
      }
    }
  }
  async run(reference: string, exportName: string, input: unknown, stationId?: string) {
    const installed = await this.install(reference);
    const definition = installed.exports.find(item => item.name === exportName);
    if (!definition) throw new ImageError('unknown_export', 'Image export not found');
    const name = definition.registeredName;
    if (stationId !== undefined) {
      if (typeof stationId !== 'string' || stationId.length < 1 || stationId.length > 255) throw new ImageError('invalid_target', 'Invalid Station target');
      if (stationId !== this.options.stationId && !await this.options.canTarget?.(stationId, name)) throw new ImageError('unavailable_target', 'Selected Station is offline, incompatible or has not installed this image');
      if (definition.kind === 'beacon' && stationId !== this.options.stationId) throw new ImageError('unavailable_target', 'Connect to the selected beacon worker to create its instance');
    }
    if (definition.kind === 'signal') return { kind: 'signal', id: await this.options.signalRunner.triggerSignal(name, input, undefined, { requiredStationId: stationId }), image: installed.image.digest, registeredName: name };
    if (definition.kind === 'broadcast') {
      if (!this.options.broadcastRunner) throw new ImageError('unavailable', 'Broadcast queue is unavailable');
      return { kind: 'broadcast', id: await this.options.broadcastRunner.trigger(name, input, { requiredStationId: stationId }), image: installed.image.digest, registeredName: name };
    }
    if (!this.options.beaconRunner) throw new ImageError('unavailable', 'Select a beacon-capable worker');
    const instance = await this.options.beaconRunner.createInstance(name, { config: input, start: true, requiredStationId: stationId });
    return { kind: 'beacon', id: instance.id, image: installed.image.digest, registeredName: name };
  }
}
