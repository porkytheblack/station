import { mkdir, lstat, chmod, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { type SignalRunner, type AnySignal, isReservedEnvKey } from "station-signal";
import { FileImageRegistry, ImageError, selectArtifact, importImage, assertDigest, type ImageRegistry, type Digest, type ImageRecord } from "station-images";
import { createImageBackend, createImageSignal, artifactGrant, cloneArtifactPolicy, type ImageArtifactPolicy, type ImageBackendConfig, type ImageSignalConfig, type ImageEnvironmentBindings } from "./shim.js";
import { prepareNativeSignal, nativeSignalName, validateNativeSignalGrants, type NativeSignalGrant } from "./native-signal.js";
export { createImageBackend, createImageSignal, type ImageBackendConfig, type ImageSignalConfig } from "./shim.js";
export interface ImageRuntimeOptions {
  registry: ImageRegistry;
  /** Private verified cache used by child processes; storage credentials stay in the daemon. */
  cacheDir?: string;
  signalRunner: SignalRunner;
  stateDir: string;
  /** No implicit host backend: trusted-local must explicitly acknowledge its trust boundary. */
  backend: ImageBackendConfig;
  /** Application environment grants. Only injected env-store values with these names reach artifacts. */
  allowedEnv?: string[];
  nativeSignals?: NativeSignalGrant[];
  artifacts?: ImageArtifactPolicy;
}
export interface InstalledImage {
  image: ImageRecord;
  images: ImageRecord[];
  /** Immutable, digest-qualified definitions available to broadcasts/schedules/beacons. */
  signals: Record<string, AnySignal>;
  generation?: ImageExecutionGeneration;
}
export interface ImageExecutionGeneration { id: string; bindings?: ImageEnvironmentBindings }
interface RuntimeState { format: "station.image-runtime/v1"; configuration: string; roots: Digest[]; generations?: { digest: Digest; generation: ImageExecutionGeneration }[] }
export function imageSignalName(digest: Digest, exportName: string, generation?: ImageExecutionGeneration): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(exportName)) throw new ImageError("invalid_reference", "Invalid image export identity");
  if (generation && !/^[a-f0-9-]{36}$/.test(generation.id)) throw new ImageError('invalid_generation', 'Invalid image generation');
  const exportId = generation ? createHash('sha256').update(exportName).digest('hex').slice(0, 32) : Buffer.from(exportName).toString('base64url');
  return `img_${digest.slice(7)}_${exportId}${generation ? `_g${generation.id.replaceAll('-', '')}` : ''}`;
}
/** Serialized install/restore; immutable wrappers preserve queued work across activation of later versions. */
export class ImageRuntime {
  readonly cache: FileImageRegistry;
  private readonly root: string;
  private readonly configuration: string;
  private readonly allowedEnv: string[];
  private readonly backend: ImageBackendConfig;
  private readonly installed = new Map<string, InstalledImage>();
  private readonly registered = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ImageRuntimeOptions) {
    options = { ...options, artifacts: cloneArtifactPolicy(options.artifacts) };
    this.options = options;
    this.root = resolve(options.stateDir);
    this.cache = options.registry instanceof FileImageRegistry && !options.cacheDir ? options.registry : new FileImageRegistry(options.cacheDir ?? join(this.root, "cache"), { maxBlobBytes: options.registry.maxBlobBytes, maxTotalBytes: options.registry.maxTotalBytes });
    this.backend = structuredClone(options.backend);
    createImageBackend(this.backend); // reject malformed policy before registering any definitions
    this.allowedEnv = [...new Set(options.allowedEnv ?? [])].sort();
    for (const key of this.allowedEnv) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || isReservedEnvKey(key)) throw new ImageError("invalid_environment", "Image environment grant contains a reserved or invalid key");
    validateNativeSignalGrants(options.nativeSignals ?? []);
    this.configuration = createHash("sha256").update(JSON.stringify({ backend: this.backend, allowedEnv: this.allowedEnv, nativeSignals: options.nativeSignals ?? [], artifacts: options.artifacts, registryRoot: this.cache.root, ...(this.cache === options.registry ? {} : { storageIdentity: options.registry.identity }) })).digest("hex");
  }
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.then(operation); this.queue = current.catch(() => {}); return current;
  }
  private async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ImageError("invalid_state", "Image runtime state must be a private real directory");
    await chmod(this.root, 0o700);
  }
  private async readState(): Promise<RuntimeState> {
    await this.initialize();
    try {
      const path = join(this.root, "active.json"), stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new ImageError("invalid_state", "Invalid image activation state");
      const state = JSON.parse(await readFile(path, "utf8")) as RuntimeState;
      if (state.format !== "station.image-runtime/v1" || state.configuration !== this.configuration || !Array.isArray(state.roots) || state.roots.length > 1024 || state.roots.some(d => !/^sha256:[a-f0-9]{64}$/.test(d))) throw new ImageError("incompatible_state", "Image runtime configuration changed or saved state is incompatible; reconcile existing activations explicitly");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: "station.image-runtime/v1", configuration: this.configuration, roots: [] };
      throw error;
    }
  }
  private async saveState(state: RuntimeState) {
    const bytes = JSON.stringify(state);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new ImageError("activation_limit", "Retained activation state exceeds 1 MiB; existing activations were preserved");
    const temp = join(this.root, `${randomUUID()}.tmp`);
    try { await writeFile(temp, bytes, { mode: 0o600, flag: "wx" }); await rename(temp, join(this.root, "active.json")); }
    finally { await rm(temp, { force: true }); }
  }
  install(reference: string): Promise<InstalledImage> {
    return this.serialized(async () => {
      const state = await this.readState(), installation = await this.prepare(reference);
      if (!state.roots.includes(installation.image.digest)) {
        if (state.roots.length >= 1024) throw new ImageError("activation_limit", "Image runtime activation limit reached");
        state.roots.push(installation.image.digest); await this.saveState(state);
      }
      this.register(installation); return installation;
    });
  }
  validateBindings(bindings: ImageEnvironmentBindings | undefined): void {
    if (bindings === undefined) return;
    if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.keys(bindings).length > 128) throw new ImageError('invalid_environment', 'Invalid deployment bindings');
    for (const [key, binding] of Object.entries(bindings)) {
      if (!this.allowedEnv.includes(key) || !binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== 1) throw new ImageError('environment_denied', 'Deployment binding exceeds operator grant');
      if ('value' in binding) {
        if (typeof binding.value !== 'string' || binding.value.includes('\0') || binding.value.length > 32768) throw new ImageError('invalid_environment', 'Invalid non-secret deployment value');
      } else if (!('fromEnv' in binding) || typeof binding.fromEnv !== 'string' || !this.allowedEnv.includes(binding.fromEnv)) throw new ImageError('environment_denied', 'Deployment reference exceeds operator grant');
    }
  }
  installGeneration(reference: string, generation: ImageExecutionGeneration): Promise<InstalledImage> {
    assertDigest(reference);
    this.validateBindings(generation.bindings);
    const snapshot = structuredClone(generation);
    return this.serialized(async () => {
      const state = await this.readState();
      state.generations ??= [];
      const previous = state.generations.find(g => g.generation.id === snapshot.id);
      // Check immutable identity before preparation can touch any existing shim.
      if (previous && (previous.digest !== reference || JSON.stringify(previous.generation) !== JSON.stringify(snapshot))) throw new ImageError('immutable_conflict', 'Generation identity cannot be reused');
      const installed = await this.prepare(reference, snapshot);
      if (!previous) {
        if (state.generations.length >= 1024) throw new ImageError('activation_limit', 'Image generation capacity reached');
        state.generations.push({ digest: installed.image.digest, generation: snapshot }); await this.saveState(state);
      }
      this.register(installed); return installed;
    });
  }
  /** Verify and cache an image without publishing definitions to the runners. */
  stage(reference: string): Promise<InstalledImage> {
    return this.serialized(async () => { await this.initialize(); return this.prepare(reference); });
  }
  restore(): Promise<InstalledImage[]> {
    return this.serialized(async () => {
      const state = await this.readState();
      // Validate and stage every root before making any of them available to the runner.
      const installations: InstalledImage[] = [];
      for (const digest of state.roots) installations.push(await this.prepare(digest));
      if (state.generations !== undefined && (!Array.isArray(state.generations) || state.generations.length > 1024)) throw new ImageError('incompatible_state', 'Invalid saved image generations');
      for (const saved of state.generations ?? []) { this.validateBindings(saved.generation.bindings); installations.push(await this.prepare(saved.digest, saved.generation)); }
      installations.forEach((installation) => this.register(installation)); return installations;
    });
  }
  private async prepare(reference: string, generation?: ImageExecutionGeneration): Promise<InstalledImage> {
    // A digest-pinned activation can recover from a complete verified local cache
    // during a remote-storage outage. Moving tags always resolve at the authority.
    let image: ImageRecord | undefined;
    if (this.cache !== this.options.registry && (reference.startsWith("sha256:") || reference.includes("@sha256:"))) {
      try { image = await this.cache.resolve(reference); }
      catch (error) {
        if (!(error instanceof ImageError) || error.code !== "not_found") throw error;
      }
    }
    image ??= this.cache === this.options.registry
      ? await this.cache.resolve(reference)
      : await importImage(this.cache, reference, this.options.registry);
    const cacheKey = `${image.digest}:${JSON.stringify(generation ?? null)}`;
    const cached = this.installed.get(cacheKey);
    if (cached) return cached;
    const images = [image, ...await this.cache.validateDependencies(image.manifest)];
    const unique = [...new Map(images.map(record => [record.digest, record])).values()];
    const target = createImageBackend(this.backend).target;
    const signals: Record<string, AnySignal> = Object.create(null);
    for (const record of unique) {
      for (const dependency of Object.values(record.manifest.nativeSignals ?? {})) {
        const grant = this.options.nativeSignals?.find(candidate => candidate.name === dependency.name && candidate.revision === dependency.revision);
        if (!grant) throw new ImageError("native_grant_denied", "Image requires a native Station signal outside its operator grant");
        const name = nativeSignalName(dependency);
        if (this.options.signalRunner.hasSignal(name) && !this.registered.has(name)) throw new ImageError("definition_conflict", "An existing definition conflicts with a native image dependency");
        const prepared = await prepareNativeSignal(grant, this.root);
        signals[name] = prepared.definition;
        const helper = new URL(import.meta.url.endsWith(".ts") ? "./native-signal.ts" : "./native-signal.js", import.meta.url).href;
        await writeFile(join(this.root, `${name}.mjs`), `import {loadNativeSignal} from ${JSON.stringify(helper)};\nexport default await loadNativeSignal(${JSON.stringify(prepared.snapshot)});\n`, { mode: 0o600 });
      }
      const artifact = selectArtifact(record.manifest, target);
      if ((await this.cache.getBlob(artifact.digest)).byteLength !== artifact.size) throw new ImageError("size_mismatch", "Image artifact size mismatch");
      for (const definition of record.manifest.exports) {
        artifactGrant(this.options.artifacts, record.digest, definition);
        const requiredKeys = [...(definition.requiredEnv ?? []), ...Object.keys(record.manifest.env ?? {})];
        if (requiredKeys.some(key => !this.allowedEnv.includes(key))) throw new ImageError("environment_denied", "Image requires an environment key outside its operator grant");
        if (definition.kind === "beacon") continue;
        const name = imageSignalName(record.digest, definition.name, generation);
        if (this.options.signalRunner.hasSignal(name) && !this.registered.has(name)) throw new ImageError("definition_conflict", "An existing definition conflicts with an immutable image export");
        const config: ImageSignalConfig = { registryRoot: this.cache.root, digest: record.digest, name, definition, backend: this.backend, allowedEnv: this.allowedEnv, bindings: generation?.bindings, artifacts: this.options.artifacts };
        signals[name] = createImageSignal(config);
        // Generate from controlled data; never import an uploaded artifact into the daemon.
        const helper = pathToFileURL(fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./shim.ts" : "./shim.js", import.meta.url))).href;
        const code = `import { createImageSignal } from ${JSON.stringify(helper)};\nexport default createImageSignal(${JSON.stringify(config)});\n`;
        const path = join(this.root, `${name}.mjs`);
        await writeFile(path, code, { mode: 0o600 });
      }
    }
    const installation = { image, images: unique, signals, generation }; this.installed.set(cacheKey, installation); return installation;
  }
  private register(installation: InstalledImage) {
    for (const [name, definition] of Object.entries(installation.signals)) {
      this.options.signalRunner.registerSignal(definition, join(this.root, `${name}.mjs`)); this.registered.add(name);
    }
  }
}
