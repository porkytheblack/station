import { signal, z, getRunContext, type AnySignal } from "station-signal";
import {
  DockerImageProcessBackend, TrustedLocalProcessBackend, FileImageRegistry,
  executeImage, validateValue, ImageError,
  type DockerImageOptions, type HostTarget, type ImageExport, type ImageProcessBackend, type Digest,
} from "station-images";

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
      try {
        const store: Record<string, string> = {};
        for (const key of config.allowedEnv) if (context.environment[key] !== undefined) store[key] = context.environment[key];
        const result = await executeImage({
          registry: new FileImageRegistry(config.registryRoot), reference: config.digest,
          exportName: config.definition.name, input, runId: context.runId, attempt: context.attempt,
          backend: createImageBackend(config.backend),
          requiredIsolation: config.backend.kind === "trusted-local" ? "trusted-host" : "container",
          environment: { allowedKeys: config.allowedEnv, store },
          timeoutMs: config.definition.timeoutMs ?? 60_000, signal: controller.signal,
        });
        // Binary stderr is intentionally not copied to central logs; arbitrary programs can print secrets.
        return result.output;
      } finally {
        process.removeListener("SIGTERM", abort); process.removeListener("SIGINT", abort); process.removeListener("disconnect", abort);
      }
    });
}
