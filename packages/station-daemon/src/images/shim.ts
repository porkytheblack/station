import { isAbsolute } from "node:path";
import { signal, z, getRunContext, type AnySignal } from "station-signal";
import {
  DockerImageProcessBackend, TrustedLocalProcessBackend, FileImageRegistry,
  executeImage, validateValue, ImageError,
  type DockerImageOptions, type HostTarget, type ImageExport, type ImageProcessBackend, type Digest,
  FileInvocationArtifactStore,
} from "station-images";
/** Operator-owned media store and explicit per-export capabilities; never inferred from business input. */
export interface ImageArtifactPolicy {
  rootDir: string;
  grants: Record<string, { readReferences?: string[]; write?: boolean }>;
  maxBytes?: number; maxArtifacts?: number; maxChunkBytes?: number; ttlMs?: number;
  maxStorageBytes?: number; maxStoredArtifacts?: number;
}
export function cloneArtifactPolicy(policy: ImageArtifactPolicy | undefined): ImageArtifactPolicy | undefined {
  if (policy === undefined) return undefined;
  const deny = (): never => { throw new ImageError('artifact_denied', 'Invalid operator artifact policy'); };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || typeof policy.rootDir !== 'string' || !isAbsolute(policy.rootDir) || !policy.grants || typeof policy.grants !== 'object' || Array.isArray(policy.grants)) deny();
  const keys = ['rootDir', 'grants', 'maxBytes', 'maxArtifacts', 'maxChunkBytes', 'ttlMs', 'maxStorageBytes', 'maxStoredArtifacts'];
  if (Object.keys(policy).some(key => !keys.includes(key)) || Object.keys(policy.grants).length > 1024) deny();
  const limits = { maxBytes: [1, 1024 ** 3], maxArtifacts: [1, 128], maxChunkBytes: [1, 256 * 1024], ttlMs: [1000, 86400000], maxStorageBytes: [1, 8 * 1024 ** 3], maxStoredArtifacts: [1, 4096] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const value = policy[key as keyof typeof limits];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min! || value > max!)) deny();
  }
  for (const [key, grant] of Object.entries(policy.grants)) {
    if (!/^sha256:[a-f0-9]{64}#[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key) || !grant || typeof grant !== 'object' || Array.isArray(grant) || Object.keys(grant).some(k => !['readReferences', 'write'].includes(k))) deny();
    if (grant.write !== undefined && typeof grant.write !== 'boolean') deny();
    if (grant.readReferences !== undefined && (!Array.isArray(grant.readReferences) || grant.readReferences.length > 128 || grant.readReferences.some(ref => typeof ref !== 'string' || !/^station-artifact:[a-f0-9]{64}$/.test(ref)) || new Set(grant.readReferences).size !== grant.readReferences.length)) deny();
  }
  return structuredClone(policy);
}
export function artifactGrant(policy: ImageArtifactPolicy | undefined, digest: string, definition: ImageExport) {
  const grant = policy?.grants[`${digest}#${definition.name}`];
  if (definition.artifacts?.read && !Array.isArray(grant?.readReferences) || definition.artifacts?.write && grant?.write !== true) throw new ImageError('artifact_denied', 'Image artifact capability requires an explicit operator grant');
  return grant;
}
export async function imageArtifactScope(config: ImageSignalConfig, invocationId: string) {
  const policy = cloneArtifactPolicy(config.artifacts);
  const grant = artifactGrant(policy, config.digest, config.definition);
  if (!policy || !config.definition.artifacts || !grant) return undefined;
  const { rootDir, grants: _, maxStorageBytes, maxStoredArtifacts, ...limits } = policy;
  return new FileInvocationArtifactStore({ rootDir, maxStorageBytes, maxStoredArtifacts }).scope({ ...limits, invocationId, permissions: config.definition.artifacts, readReferences: config.definition.artifacts.read ? grant.readReferences : [] });
}
export type ImageEnvironmentBindings = Record<string, { value: string } | { fromEnv: string }>;
export function resolveDeploymentBindings(bindings: ImageEnvironmentBindings | undefined, store: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, binding] of Object.entries(bindings ?? {})) {
    if ('value' in binding) result[key] = binding.value;
    else {
      const value = store[binding.fromEnv];
      if (value === undefined) throw new ImageError('missing_environment', 'A deployment environment reference is unavailable');
      result[key] = value;
    }
  }
  return result;
}

/** Operator configuration only. Never accept this union from an image or tenant request. */
export type ImageBackendConfig =
  | { kind: "trusted-local"; allowUnsafeHostExecution: true; target: HostTarget; nodeExecutable?: string; bunExecutable?: string }
  | { kind: "docker"; options: DockerImageOptions };
export interface ImageSignalConfig {
  registryRoot: string;
  digest: Digest;
  name: string;
  definition: ImageExport;
  backend: ImageBackendConfig;
  allowedEnv: string[];
  bindings?: ImageEnvironmentBindings;
  artifacts?: ImageArtifactPolicy;
}
export function createImageBackend(config: ImageBackendConfig): ImageProcessBackend {
  if (config.kind === "trusted-local") return new TrustedLocalProcessBackend(config);
  if (config.kind === "docker") return new DockerImageProcessBackend(config.options);
  throw new ImageError("unsupported_backend", "Unknown image execution backend");
}
/** Imports only trusted Station modules. Uploaded code stays a verified executable artifact. */
export function createImageSignal(config: ImageSignalConfig): AnySignal {
  if (config.definition.kind === "beacon") throw new ImageError("invalid_export", "Expected a signal or broadcast planner image export");
  const inputSchema = z.unknown().superRefine((value, context) => {
    try { validateValue(config.definition.inputSchema, value); }
    catch { context.addIssue({ code: "custom", message: "Image input does not match its declared schema." }); }
  });
  // Give the inner supervisor a shutdown window before SignalRunner's outer deadline.
  return signal(config.name).input(inputSchema).output(z.unknown())
    .timeout((config.definition.timeoutMs ?? 60_000) + 2_000).retries(0)
    .run(async (input) => {
      const context = getRunContext();
      if (!context || context.signalName !== config.name) throw new ImageError("missing_run_context", "Image signals must run through their registered SignalRunner");
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once("SIGTERM", abort); process.once("SIGINT", abort); process.once("disconnect", abort);
      let artifacts: Awaited<ReturnType<typeof imageArtifactScope>>;
      try {
        artifacts = await imageArtifactScope(config, `run:${context.runId}:${context.attempt}`);
        const store: Record<string, string> = {};
        for (const key of config.allowedEnv) if (context.environment[key] !== undefined) store[key] = context.environment[key];
        const result = await executeImage({
          registry: new FileImageRegistry(config.registryRoot), reference: config.digest,
          exportName: config.definition.name, input, runId: context.runId, attempt: context.attempt,
          backend: createImageBackend(config.backend),
          requiredIsolation: config.backend.kind === "trusted-local" ? "trusted-host" : "container",
          environment: { allowedKeys: config.allowedEnv, store, bindings: resolveDeploymentBindings(config.bindings, store) },
          timeoutMs: config.definition.timeoutMs ?? 60_000, signal: controller.signal,
          artifacts,
        });
        // Binary stderr is intentionally not copied to central logs; arbitrary programs can print secrets.
        return result.output;
      } finally {
        try { await artifacts?.close(); }
        finally { process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); process.removeListener("disconnect", abort); }
      }
    });
}
