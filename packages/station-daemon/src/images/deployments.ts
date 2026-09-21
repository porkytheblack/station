import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImageError, validateManifest, assertDigest, manifestDigest, type ImageRecord } from 'station-images';
import type { ImageEnvironmentBindings } from './shim.js';

export interface DeploymentGeneration {
  id: string;
  image: ImageRecord;
  aliases: Record<string, string>;
  stationId?: string;
  createdAt: string;
  bindings?: ImageEnvironmentBindings;
  invocationEnv?: string[];
  sourceGeneration?: string;
  everActivated?: boolean;
}
export interface ImageDeployment {
  id: string;
  name: string;
  revision: number;
  activeGeneration?: string;
  generations: DeploymentGeneration[];
  history: { revision: number; action: 'stage' | 'activate' | 'rollback' | 'drain' | 'invoke'; generation?: string; at: string }[];
  /** Retained explicit replacement intent; old incarnations are never rewritten. */
  rollouts?: BeaconRollout[];
}
export interface BeaconRollout {
  id: string; sourceInstance: string; sourceName: string; targetInstance: string;
  generation: string; export: string; config: string; stationId?: string;
  createdAt: string; completedAt?: string; failedAt?: string; error?: string; cancelledAt?: string;
}
export interface DeploymentSnapshot { format: 'station.deployments/v1'; identity: string; revision: number; deployments: ImageDeployment[] }
/** Atomic compare-and-swap must cover all writers sharing this namespace. */
export interface ImageDeploymentStorage {
  read(): Promise<DeploymentSnapshot | null>;
  compareAndSwap(expectedRevision: number, next: DeploymentSnapshot): Promise<boolean>;
}
const maxBytes = 8 * 1024 * 1024;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const invalid = () => new ImageError('invalid_deployment', 'Invalid deployment or generation');

/** Private local storage. An interrupted write lock fails closed until operator reconciliation. */
export class FileImageDeploymentStorage implements ImageDeploymentStorage {
  constructor(private readonly path: string) {}
  async read(): Promise<DeploymentSnapshot | null> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes) throw invalid();
      return JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  async compareAndSwap(expectedRevision: number, next: DeploymentSnapshot): Promise<boolean> {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > maxBytes) throw new ImageError('deployment_limit', 'Deployment history capacity reached; no retained generation was removed');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(`${this.path}.lock`, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ImageError('deployment_busy', 'Deployment store is locked; retry or reconcile an interrupted writer'); throw error; }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      if (((await this.read())?.revision ?? 0) !== expectedRevision) return false;
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } finally { await rm(temp, { force: true }); await lock.close(); await rm(`${this.path}.lock`, { force: true }); }
  }
}

/** Generations are immutable; activation changes only the pointer used by future invocations. */
export class ImageDeployments {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: ImageDeploymentStorage, private readonly identity: string) {}
  private async read(): Promise<DeploymentSnapshot> {
    const state = structuredClone(await this.storage.read()) ?? { format: 'station.deployments/v1', identity: this.identity, revision: 0, deployments: [] };
    if (state.format !== 'station.deployments/v1' || state.identity !== this.identity || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.deployments) || state.deployments.length > 1024) throw new ImageError('incompatible_state', 'Deployment namespace or saved state is incompatible');
    const ids = new Set<string>(), names = new Set<string>();
    for (const deployment of state.deployments) {
      if (!identifier.test(deployment.id) || !identifier.test(deployment.name) || ids.has(deployment.id) || names.has(deployment.name) || !Number.isSafeInteger(deployment.revision) || deployment.revision < 1 || !Array.isArray(deployment.generations) || !Array.isArray(deployment.history)) throw invalid();
      ids.add(deployment.id); names.add(deployment.name);
      const generations = new Set<string>();
      for (const generation of deployment.generations) {
        if (!identifier.test(generation.id) || generations.has(generation.id)) throw invalid();
        generations.add(generation.id); assertDigest(generation.image.digest); validateManifest(generation.image.manifest);
        if (generation.invocationEnv !== undefined && (!Array.isArray(generation.invocationEnv) || generation.invocationEnv.length > 128 || generation.invocationEnv.some(k => typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) || new Set(generation.invocationEnv).size !== generation.invocationEnv.length)) throw invalid();
        if (manifestDigest(generation.image.manifest) !== generation.image.digest) throw invalid();
        this.validateAliases(generation.aliases, generation.image);
      }
      if (deployment.activeGeneration && !generations.has(deployment.activeGeneration)) throw invalid();
      if (deployment.rollouts !== undefined) {
        if (!Array.isArray(deployment.rollouts) || deployment.rollouts.length > 256) throw invalid();
        const operations = new Set<string>();
        for (const rollout of deployment.rollouts) {
          if (!identifier.test(rollout.id) || operations.has(rollout.id) || !generations.has(rollout.generation) || typeof rollout.sourceInstance !== 'string' || !rollout.sourceInstance || typeof rollout.sourceName !== 'string' || !/^rollout-[a-f0-9]{64}$/.test(rollout.targetInstance) || typeof rollout.export !== 'string' || typeof rollout.config !== 'string' || rollout.config.length > 1024 * 1024) throw invalid();
          for(const field of ['completedAt','failedAt','cancelledAt'] as const)if(rollout[field]!==undefined&&(typeof rollout[field]!=='string'||!Number.isFinite(Date.parse(rollout[field]!))))throw invalid();
          if(rollout.error!==undefined&&(typeof rollout.error!=='string'||rollout.error.length>1024))throw invalid();
          operations.add(rollout.id);
        }
      }
    }
    return state;
  }
  private validateAliases(aliases: Record<string, string>, image: ImageRecord) {
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.keys(aliases).length < 1 || Object.keys(aliases).length > 128) throw invalid();
    for (const [alias, target] of Object.entries(aliases)) if (!identifier.test(alias) || ['__proto__', 'constructor', 'prototype'].includes(alias) || !image.manifest.exports.some(e => e.name === target)) throw invalid();
  }
  private mutate<T>(fn: (state: DeploymentSnapshot) => T, allocating: boolean | (() => boolean) = false): Promise<T> {
    const pending = this.queue.then(async () => {
      const state = await this.read(), revision = state.revision;
      // Preserve rollback eligibility independently of the bounded audit window.
      for (const deployment of state.deployments) for (const generation of deployment.generations) if (deployment.history.some(h => h.generation === generation.id && (h.action === 'activate' || h.action === 'rollback'))) generation.everActivated = true;
      const result = fn(state); state.revision++;
      const allocated=typeof allocating==='function'?allocating():allocating;
      for (const deployment of state.deployments) deployment.history = deployment.history.slice(-512);
      // Audit is bounded globally too; immutable execution identities are never evicted.
      let auditBudget=4096;
      for(const deployment of [...state.deployments].reverse()){deployment.history=deployment.history.slice(-Math.min(auditBudget,deployment.history.length));if(auditBudget===0)deployment.history=[];auditBudget-=deployment.history.length;}
      if(!allocated&&Buffer.byteLength(JSON.stringify(state))>maxBytes)for(const deployment of state.deployments)deployment.history=[];
      if (allocated && Buffer.byteLength(JSON.stringify(state)) > maxBytes - 512 * 1024) throw new ImageError('deployment_limit', 'Retained deployment capacity reached; control-plane reserve preserved');
      if (!await this.storage.compareAndSwap(revision, state)) throw new ImageError('revision_conflict', 'Deployment changed; refresh before retrying');
      return structuredClone(result);
    });
    this.queue = pending.catch(() => {}); return pending;
  }
  async list(): Promise<ImageDeployment[]> { return structuredClone((await this.read()).deployments); }
  async get(id: string): Promise<ImageDeployment> {
    const deployment = (await this.read()).deployments.find(d => d.id === id);
    if (!deployment) throw new ImageError('not_found', 'Deployment not found');
    return structuredClone(deployment);
  }
  recordRollout(id: string, expectedRevision: number, rollout: BeaconRollout) {
    return this.mutate(state => {
      const deployment = state.deployments.find(d => d.id === id);
      if (!deployment) throw new ImageError('not_found', 'Deployment not found');
      const previous = deployment.rollouts?.find(r => r.id === rollout.id);
      if (previous) {
        if (previous.sourceInstance !== rollout.sourceInstance || previous.generation !== rollout.generation || previous.export !== rollout.export) throw new ImageError('immutable_conflict', 'Rollout identity already used');
        return previous;
      }
      if (deployment.revision !== expectedRevision) throw new ImageError('revision_conflict', 'Deployment changed; refresh before retrying');
      if ((deployment.rollouts?.length ?? 0) >= 256 || deployment.rollouts?.some(r => r.sourceInstance === rollout.sourceInstance && !r.completedAt && !r.failedAt && !r.cancelledAt)) throw new ImageError('rollout_conflict', 'A replacement is pending or retained rollout capacity is reached');
      (deployment.rollouts ??= []).push(structuredClone(rollout)); deployment.revision++;
      return rollout;
    }, true);
  }
  completeRollout(id: string, rolloutId: string) {
    return this.mutate(state => {
      const deployment = state.deployments.find(d => d.id === id);
      const rollout = deployment?.rollouts?.find(r => r.id === rolloutId);
      if (!deployment || !rollout) throw new ImageError('not_found', 'Rollout not found');
      if (rollout.cancelledAt || rollout.failedAt) throw new ImageError('rollout_cancelled', 'Rollout is no longer pending');
      if (!rollout.completedAt) { rollout.completedAt = new Date().toISOString(); deployment.revision++; }
      return rollout;
    });
  }
  failRollout(id: string, rolloutId: string, error: string) {
    return this.mutate(state => { const deployment=state.deployments.find(d=>d.id===id);const rollout=deployment?.rollouts?.find(r=>r.id===rolloutId);if(!rollout||!deployment)throw new ImageError('not_found','Rollout not found');if(!rollout.completedAt&&!rollout.cancelledAt){rollout.failedAt=new Date().toISOString();rollout.error=error.slice(0,1024);deployment.revision++;}return rollout; });
  }
  cancelRollout(id: string, rolloutId: string, expectedRevision: number) {
    return this.mutate(state=>{const deployment=state.deployments.find(d=>d.id===id);if(!deployment)throw new ImageError('not_found','Deployment not found');if(deployment.revision!==expectedRevision)throw new ImageError('revision_conflict','Deployment changed; refresh before retrying');const rollout=deployment.rollouts?.find(r=>r.id===rolloutId);if(!rollout)throw new ImageError('not_found','Rollout not found');if(rollout.completedAt)throw new ImageError('rollout_conflict','Completed rollout cannot be cancelled');if(!rollout.cancelledAt){rollout.cancelledAt=new Date().toISOString();deployment.revision++;}return rollout;});
  }
  stage(name: string, image: ImageRecord, aliases?: Record<string, string>, stationId?: string, environment?: ImageEnvironmentBindings, invocationEnv?: string[]): Promise<ImageDeployment> {
    if (typeof name !== 'string' || !identifier.test(name) || stationId !== undefined && (typeof stationId !== 'string' || stationId.length < 1 || stationId.length > 255)) throw invalid();
    const bindings = structuredClone(aliases ?? Object.fromEntries(image.manifest.exports.map(e => [e.name, e.name])));
    this.validateAliases(bindings, image);
    const generation: DeploymentGeneration = { id: randomUUID(), image: structuredClone(image), aliases: bindings, stationId, createdAt: new Date().toISOString(), bindings: structuredClone(environment), invocationEnv: invocationEnv ? [...invocationEnv] : undefined };
    return this.mutate(state => {
      let deployment = state.deployments.find(d => d.name === name);
      if (!deployment) {
        if (state.deployments.length >= 1024) throw new ImageError('deployment_limit', 'Deployment capacity reached');
        deployment = { id: randomUUID(), name, revision: 0, generations: [], history: [] }; state.deployments.push(deployment);
      }
      if (deployment.generations.filter(g => !g.sourceGeneration).length >= 128) throw new ImageError('deployment_limit', 'Retained generation capacity reached');
      deployment.generations.push(generation); deployment.revision++;
      deployment.history.push({ action: 'stage', generation: generation.id, revision: deployment.revision, at: new Date().toISOString() });
      return deployment;
    }, true);
  }
  invocation(id: string, expectedRevision: number, sourceGeneration: string, bindings: ImageEnvironmentBindings): Promise<DeploymentGeneration> {
    let allocated=false;
    return this.mutate(state => {
      const deployment = state.deployments.find(d => d.id === id);
      if (!deployment) throw new ImageError('not_found', 'Deployment not found');
      if (deployment.revision !== expectedRevision || deployment.activeGeneration !== sourceGeneration) throw new ImageError('revision_conflict', 'Deployment changed before invocation');
      const source = deployment.generations.find(g => g.id === sourceGeneration)!;
      if (Object.keys(bindings).some(key => !source.invocationEnv?.includes(key))) throw new ImageError('environment_denied', 'Invocation override is not granted by this deployment');
      const merged={...source.bindings,...structuredClone(bindings)};
      const canonical=(value:ImageEnvironmentBindings)=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))]));
      let generation=deployment.generations.find(g=>g.sourceGeneration===sourceGeneration&&canonical(g.bindings??{})===canonical(merged));
      if(!generation){
        allocated=true;
        if (deployment.generations.filter(g => g.sourceGeneration).length >= 128) throw new ImageError('deployment_limit', 'Retained generation capacity reached');
        generation={ ...structuredClone(source), id: randomUUID(), sourceGeneration, bindings: merged, createdAt: new Date().toISOString() };
        deployment.generations.push(generation);
      }
      deployment.revision++;
      deployment.history.push({ action: 'invoke', generation: generation.id, revision: deployment.revision, at: new Date().toISOString() });
      return generation;
    }, ()=>allocated);
  }
  change(id: string, expectedRevision: number, action: 'activate' | 'rollback' | 'drain', generation?: string): Promise<ImageDeployment> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw invalid();
    return this.mutate(state => {
      const deployment = state.deployments.find(d => d.id === id);
      if (!deployment) throw new ImageError('not_found', 'Deployment not found');
      if (deployment.revision !== expectedRevision) throw new ImageError('revision_conflict', 'Deployment changed; refresh before retrying');
      if (action !== 'drain') {
        if (!deployment.generations.some(g => g.id === generation)) throw invalid();
        if (action === 'rollback' && !deployment.generations.find(g => g.id === generation)?.everActivated && !deployment.history.some(h => (h.action === 'activate' || h.action === 'rollback') && h.generation === generation)) throw new ImageError('invalid_rollback', 'Rollback requires a previously activated generation');
      }
      if (action !== 'drain') deployment.generations.find(g => g.id === generation)!.everActivated = true;
      deployment.activeGeneration = action === 'drain' ? undefined : generation;
      deployment.revision++;
      deployment.history.push({ revision: deployment.revision, action, generation, at: new Date().toISOString() });
      return deployment;
    });
  }
}
