import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { SignalRunner } from 'station-signal';
import type { BroadcastRunner } from 'station-broadcast';
import type { BeaconRunner, BeaconStateAdapter, BeaconInstance } from 'station-beacon';
import { importImage, ImageError, selectArtifact, validateValue, FileInvocationArtifactStore, type ImageRegistry, type ImageSource, type ImageRecord, type ImageExport } from 'station-images';
import { nativeSignalName } from './native-signal.js';
import { ImageRuntime, imageSignalName, type ImageRuntimeOptions, type InstalledImage, type ImageExecutionGeneration } from './runtime.js';
import { createImageBackend, cloneArtifactPolicy, type ImageEnvironmentBindings } from './shim.js';
import { createImageBeacon } from './beacon-shim.js';
import { ImageDeployments, FileImageDeploymentStorage, type ImageDeploymentStorage } from './deployments.js';
import { ImagePreparations } from './preparation.js';
import type { StationNetworkAdapter } from 'station-network';

export type DaemonImageExecution = Pick<ImageRuntimeOptions, 'backend' | 'allowedEnv' | 'nativeSignals' | 'artifacts'>;
export interface ImageControllerOptions extends DaemonImageExecution {
  registry: ImageRegistry;
  cacheDir?: string;
  source?: ImageSource;
  signalRunner: SignalRunner;
  broadcastRunner?: BroadcastRunner;
  beaconRunner?: BeaconRunner;
  beaconAdapter?: BeaconStateAdapter;
  maxBeaconInstances?: number;
  stateDir: string;
  stationId?: string;
  canTarget?: (stationId: string, signalName: string) => Promise<boolean>;
  deploymentStorage?: ImageDeploymentStorage;
  preparation?: { adapter: StationNetworkAdapter; networkId: string; stationId: string };
  rolloutCoordinator?: StationNetworkAdapter;
}
/** Installs controlled shims into the existing runners; digests become queue identity. */
export class ImageController {
  readonly deployments: ImageDeployments;
  readonly preparations?: ImagePreparations;
  private readonly installable = new Map<string, { digest: string; generation?: ImageExecutionGeneration }>();
  private readonly runtime: ImageRuntime;
  private readonly exports = new Map<string, { image: ImageRecord; definition: ImageExport; generation?: ImageExecutionGeneration }>();
  private readonly beacons = new Set<string>();
  private readonly synced = new Set<string>();
  private reconcilingRollouts = false;
  private lastArtifactReap = 0;
  constructor(private readonly options: ImageControllerOptions) {
    options = { ...options, artifacts: cloneArtifactPolicy(options.artifacts) };
    this.options = options;
    this.runtime = new ImageRuntime(options);
    this.deployments = new ImageDeployments(options.deploymentStorage ?? new FileImageDeploymentStorage(join(options.stateDir, 'deployments.json')), options.registry.identity);
    if (options.preparation) {
      this.preparations = new ImagePreparations(options.preparation);
      options.signalRunner.setDefinitionPreparer(async run => {
        const candidate = this.installable.get(run.signalName);
        if (!candidate) return false;
        await this.preparations!.request(run, async stillOwned => {
          if (options.source) {
            const check = async () => { if (!await stillOwned()) throw new ImageError('preparation_expired', 'Preparation reservation expired'); };
            await importImage(options.registry, candidate.digest, {
              resolve: async reference => { await check(); return options.source!.resolve(reference); },
              getBlob: async digest => { await check(); return options.source!.getBlob(digest); },
            });
          }
          await this.runtime.stage(candidate.digest);
          if (!await stillOwned()) throw new ImageError('preparation_expired', 'Preparation reservation expired');
          if (candidate.generation) await this.wire(await this.runtime.installGeneration(candidate.digest, candidate.generation));
          else await this.install(candidate.digest);
        });
        return true;
      });
    }
    options.beaconRunner?.setDependencyTrigger(async request => {
      const source = this.exports.get(request.beaconName);
      const dependency = source?.image.manifest.dependencies?.[request.alias];
      if (!source || !dependency) throw new ImageError('dependency_denied', 'Undeclared image dependency');
      const target = await this.runtime.cache.resolve(dependency.image);
      const name = imageSignalName(target.digest, dependency.export, source.generation);
      const key = `beacon:${request.instanceId}:${request.incarnation}:${request.requestId}`;
      if (dependency.kind === 'signal') return options.signalRunner.triggerSignal(name, request.input, undefined, { idempotencyKey: key });
      if (!options.broadcastRunner) throw new ImageError('unavailable', 'Broadcast queue is unavailable');
      return options.broadcastRunner.trigger(name, request.input, { idempotencyKey: key });
    });
  }
  targetKind(name: string): 'signal' | 'broadcast' | 'beacon' | undefined { return this.exports.get(name)?.definition.kind; }
  installableNames(): string[] { return [...this.installable.keys()]; }
  async stop() { await this.preparations?.stop(); }
  async reapArtifacts() {
    const policy = this.options.artifacts;
    if (!policy || Date.now() - this.lastArtifactReap < 60000) return;
    this.lastArtifactReap = Date.now();
    await new FileInvocationArtifactStore(policy).reapExpired();
  }
  async sync(catalog: ImageRecord[]): Promise<void> {
    const target = createImageBackend(this.options.backend).target;
    for (const record of catalog) {
      if (this.synced.has(record.digest)) continue;
      try {
        selectArtifact(record.manifest, target);
        if (this.preparations && !record.manifest.exports.some(e => e.kind === 'beacon')) {
          for (const definition of record.manifest.exports) if (definition.kind !== 'beacon') this.installable.set(imageSignalName(record.digest, definition.name), { digest: record.digest });
          continue;
        }
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
  async generations() {
    const deployments = await this.deployments.list();
    return deployments.flatMap(d => d.generations.filter(g => d.history.some(h => h.generation === g.id && (h.action === 'activate' || h.action === 'rollback' || h.action === 'invoke'))).map(g => ({ digest: g.image.digest, generation: { id: g.id, bindings: g.bindings }, stationId: g.stationId })));
  }
  async syncGenerations(records: { digest: string; generation: ImageExecutionGeneration; stationId?: string }[]) {
    for (const record of records) {
      if (record.stationId && record.stationId !== this.options.stationId) continue;
      try {
        if (this.preparations) {
          this.runtime.validateBindings(record.generation.bindings);
          const image = await (this.options.source ?? this.options.registry).resolve(record.digest);
          selectArtifact(image.manifest, createImageBackend(this.options.backend).target);
          if (!image.manifest.exports.some(e => e.kind === 'beacon')) {
            for (const definition of image.manifest.exports) this.installable.set(imageSignalName(image.digest, definition.name, record.generation), { digest: record.digest, generation: record.generation });
            continue;
          }
        }
        await this.install(record.digest);
        await this.wire(await this.runtime.installGeneration(record.digest, record.generation));
      } catch (error) {
        if (error instanceof ImageError && ['incompatible_target', 'environment_denied'].includes(error.code)) continue;
        throw error;
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
  async stageDeployment(name: string, reference: string, aliases?: Record<string, string>, stationId?: string, bindings?: ImageEnvironmentBindings, invocationEnv?: string[]) {
    this.runtime.validateBindings(bindings);
    if (invocationEnv !== undefined) {
      if (!Array.isArray(invocationEnv) || invocationEnv.length > 128 || invocationEnv.some(k => typeof k !== 'string') || new Set(invocationEnv).size !== invocationEnv.length) throw new ImageError('environment_denied', 'Invalid invocation environment grant');
      this.runtime.validateBindings(Object.fromEntries(invocationEnv.map(key => [key, { value: '' }])));
    }
    let staged: InstalledImage;
    try { staged = await this.runtime.stage(reference); }
    catch (error) {
      if (!(error instanceof ImageError) || error.code !== 'not_found' || !this.options.source) throw error;
      staged = await this.runtime.stage((await importImage(this.options.registry, reference, this.options.source)).digest);
    }
    return this.deployments.stage(name, staged.image, aliases, stationId, bindings, invocationEnv);
  }
  async changeDeployment(id: string, revision: number, action: 'activate' | 'rollback' | 'drain', generation?: string) {
    if (action !== 'drain') {
      const deployment = await this.deployments.get(id);
      if (deployment.revision !== revision) throw new ImageError('revision_conflict', 'Deployment changed; refresh before retrying');
      const selected = deployment.generations.find(g => g.id === generation);
      if (!selected) throw new ImageError('invalid_deployment', 'Generation not found');
      // Preparation may fail, but can never replace the active alias pointer.
      if (action === 'rollback' && !deployment.history.some(h => (h.action === 'activate' || h.action === 'rollback') && h.generation === generation)) throw new ImageError('invalid_rollback', 'Rollback requires a previously activated generation');
      await this.wire(await this.runtime.installGeneration(selected.image.digest, { id: selected.id, bindings: selected.bindings }));
    }
    return this.deployments.change(id, revision, action, generation);
  }
  async runDeployment(id: string, alias: string, input: unknown, environment?: ImageEnvironmentBindings) {
    const deployment = await this.deployments.get(id);
    let generation = deployment.generations.find(g => g.id === deployment.activeGeneration);
    if (!generation) throw new ImageError('deployment_inactive', 'Activate a generation before invoking this deployment');
    if (!Object.hasOwn(generation.aliases, alias)) throw new ImageError('unknown_export', 'Deployment alias not found');
    if (environment !== undefined) {
      this.runtime.validateBindings(environment);
      generation = await this.deployments.invocation(id, deployment.revision, generation.id, environment);
    }
    const installed = await this.runtime.installGeneration(generation.image.digest, { id: generation.id, bindings: generation.bindings });
    await this.wire(installed);
    const run = await this.enqueue(installed, generation.aliases[alias]!, input, generation.stationId);
    return { ...run, deployment: id, generation: generation.id, deploymentRevision: deployment.revision + (environment === undefined ? 0 : 1) };
  }
  async rolloutBeacon(id: string, request: { operationId: string; expectedRevision: number; sourceInstance: string; generation: string; alias: string }) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId) || !Number.isSafeInteger(request.expectedRevision)) throw new ImageError('invalid_rollout', 'Invalid rollout operation identity or revision');
    const adapter = this.options.beaconAdapter;
    if (!adapter) throw new ImageError('unavailable', 'Beacon instance storage is unavailable');
    const deployment = await this.deployments.get(id), generation = deployment.generations.find(g => g.id === request.generation);
    const targetExport = generation?.aliases[request.alias];
    const definition = generation?.image.manifest.exports.find(e => e.name === targetExport && e.kind === 'beacon');
    if (!generation || !definition || !deployment.history.some(h => h.generation === generation.id && (h.action === 'activate' || h.action === 'rollback'))) throw new ImageError('invalid_rollout', 'Select a previously activated beacon generation');
    const source = await adapter.getInstance(request.sourceInstance);
    if (!source || !deployment.generations.some(g => g.image.manifest.exports.some(e => e.kind === 'beacon' && source.beaconName === imageSignalName(g.image.digest, e.name, { id: g.id })))) throw new ImageError('invalid_rollout', 'Source instance does not belong to this deployment');
    validateValue(definition.configSchema, JSON.parse(source.config ?? '{}'));
    await this.wire(await this.runtime.installGeneration(generation.image.digest, { id: generation.id, bindings: generation.bindings }));
    const stationId = generation.stationId ?? source.requiredStationId;
    if (stationId && stationId !== this.options.stationId && !await this.options.canTarget?.(stationId, imageSignalName(generation.image.digest, definition.name, { id: generation.id }))) throw new ImageError('unavailable_target', 'Replacement Station has not prepared this beacon generation');
    const rollout = await this.deployments.recordRollout(id, request.expectedRevision, {
      id: request.operationId, sourceInstance: source.id, sourceName: source.beaconName,
      targetInstance: `rollout-${createHash('sha256').update(`${id}:${request.operationId}`).digest('hex')}`,
      generation: generation.id, export: definition.name, config: source.config ?? '{}', stationId, createdAt: new Date().toISOString(),
    });
    await this.reconcileRollouts();
    return (await this.deployments.get(id)).rollouts!.find(r => r.id === rollout.id)!;
  }
  /** Durable stop-before-replace intent. Replayed after restart; never rewrites a live incarnation. */
  async reconcileRollouts() {
    if (this.reconcilingRollouts || !this.options.beaconAdapter) return;
    this.reconcilingRollouts = true;
    const adapter = this.options.beaconAdapter;
    const coordinator = this.options.rolloutCoordinator;
    const lease = { name: `image-rollout:${createHash('sha256').update(this.options.registry.identity).digest('hex')}`, holderId: this.options.stationId ?? 'headquarters', token: randomUUID(), expiresAt: new Date(Date.now() + 300000) };
    let acquired = false;
    const ensureLease = async () => {
      if (coordinator && !await coordinator.renewControllerLease(lease.name, lease.holderId, lease.token, new Date(Date.now() + 300000), new Date())) throw new ImageError('rollout_conflict', 'Rollout controller lease lost');
    };
    try {
      if (coordinator) {
        acquired = await coordinator.acquireControllerLease(lease, new Date());
        if (!acquired) return;
      }
      for (const deployment of await this.deployments.list()) for (const rollout of deployment.rollouts ?? []) {
        if (rollout.completedAt) continue;
        const source = await adapter.getInstance(rollout.sourceInstance);
        if (!source || source.beaconName !== rollout.sourceName) throw new ImageError('rollout_conflict', 'Retain the source instance until replacement completes');
        if (source.desiredState !== 'stopped') { await ensureLease(); await adapter.updateInstance(source.id, { desiredState: 'stopped', updatedAt: new Date() }); }
        if (this.options.beaconRunner) { await ensureLease(); await this.options.beaconRunner.stopInstance(source.id); }
        if (source.status !== 'stopped') continue;
        const generation = deployment.generations.find(g => g.id === rollout.generation)!;
        await ensureLease();
        await this.wire(await this.runtime.installGeneration(generation.image.digest, { id: generation.id, bindings: generation.bindings }));
        const name = imageSignalName(generation.image.digest, rollout.export, { id: generation.id });
        const existing = await adapter.getInstance(rollout.targetInstance);
        if (existing && (existing.beaconName !== name || existing.config !== rollout.config || existing.requiredStationId !== rollout.stationId)) throw new ImageError('rollout_conflict', 'Replacement instance identity conflicts');
        if (!existing) {
          await ensureLease();
          if (this.options.beaconRunner) await this.options.beaconRunner.createInstance(name, { id: rollout.targetInstance, config: JSON.parse(rollout.config), start: true, requiredStationId: rollout.stationId });
          else {
            const now = new Date();
            await adapter.upsertInstance({ id: rollout.targetInstance, beaconName: name, config: rollout.config, origin: 'api', status: 'backoff', desiredState: 'running', incarnation: 0, restartCount: 0, requiredStationId: rollout.stationId, nextRestartAt: now, createdAt: now, updatedAt: now });
          }
        }
        const replacement = await adapter.getInstance(rollout.targetInstance);
        if (replacement?.readyAt && replacement.status === 'running') { await ensureLease(); await this.deployments.completeRollout(deployment.id, rollout.id); }
      }
    } finally {
      try { if (coordinator && acquired) await coordinator.releaseControllerLease(lease.name, lease.holderId, lease.token); }
      finally { this.reconcilingRollouts = false; }
    }
  }
  private async wire(installed: InstalledImage): Promise<void> {
    for (const image of installed.images) for (const definition of image.manifest.exports) {
      const name = imageSignalName(image.digest, definition.name, installed.generation);
      this.exports.set(name, { image, definition, generation: installed.generation });
      if (definition.kind === 'broadcast' && this.options.broadcastRunner) {
        const dependencies: Record<string, string> = Object.create(null);
        for (const local of image.manifest.exports) if (local.kind === "signal") dependencies[local.name] = imageSignalName(image.digest, local.name, installed.generation);
        for (const [alias, dep] of Object.entries(image.manifest.dependencies ?? {})) {
          if (dep.kind !== 'signal') continue;
          const target = await this.runtime.cache.resolve(dep.image);
          dependencies[alias] = imageSignalName(target.digest, dep.export, installed.generation);
        }
        for (const [alias, dependency] of Object.entries(image.manifest.nativeSignals ?? {})) dependencies[alias] = nativeSignalName(dependency);
        this.options.broadcastRunner.registerPlanner(name, { signalName: name, dependencies });
      }
      if (definition.kind === 'beacon' && this.options.beaconRunner && !this.beacons.has(name)) {
        const config = { registryRoot: this.runtime.cache.root, digest: image.digest, name, definition, backend: this.options.backend, allowedEnv: [...(this.options.allowedEnv ?? [])], bindings: installed.generation?.bindings, artifacts: this.options.artifacts };
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
    await this.install(reference);
    return this.enqueue(await this.runtime.install(reference), exportName, input, stationId);
  }
  private async enqueue(installed: InstalledImage, exportName: string, input: unknown, stationId?: string) {
    const definition = installed.image.manifest.exports.find(item => item.name === exportName);
    if (!definition) throw new ImageError('unknown_export', 'Image export not found');
    const name = imageSignalName(installed.image.digest, definition.name, installed.generation);
    if (stationId !== undefined) {
      if (typeof stationId !== 'string' || stationId.length < 1 || stationId.length > 255) throw new ImageError('invalid_target', 'Invalid Station target');
      if (stationId !== this.options.stationId && !await this.options.canTarget?.(stationId, name)) throw new ImageError('unavailable_target', 'Selected Station is offline, incompatible or has not installed this image');
    }
    if (definition.kind === 'signal') return { kind: 'signal', id: await this.options.signalRunner.triggerSignal(name, input, undefined, { requiredStationId: stationId }), image: installed.image.digest, registeredName: name };
    if (definition.kind === 'broadcast') {
      if (!this.options.broadcastRunner) throw new ImageError('unavailable', 'Broadcast queue is unavailable');
      return { kind: 'broadcast', id: await this.options.broadcastRunner.trigger(name, input, { requiredStationId: stationId }), image: installed.image.digest, registeredName: name };
    }
    if (!this.options.beaconRunner) {
      const adapter = this.options.beaconAdapter;
      if (!adapter) throw new ImageError('unavailable', 'Beacon instance storage is unavailable');
      validateValue(definition.configSchema, input);
      if ((await adapter.listInstances({ beaconName: name })).length >= (this.options.maxBeaconInstances ?? 100)) throw new ImageError('instance_limit', 'Beacon instance capacity reached');
      const now = new Date();
      const instance: BeaconInstance = { id: adapter.generateId(), beaconName: name, origin: 'api', status: 'backoff', desiredState: 'running', incarnation: 0, restartCount: 0, config: JSON.stringify(input), nextRestartAt: now, createdAt: now, updatedAt: now, requiredStationId: stationId };
      await adapter.upsertInstance(instance);
      return { kind: 'beacon', id: instance.id, image: installed.image.digest, registeredName: name };
    }
    const instance = await this.options.beaconRunner.createInstance(name, { config: input, start: true, requiredStationId: stationId });
    return { kind: 'beacon', id: instance.id, image: installed.image.digest, registeredName: name };
  }
}
