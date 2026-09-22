export const IMAGE_FORMAT = "station.image/v1" as const;
export const PROCESS_PROTOCOL = "station.process/v1" as const;
export type Digest = `sha256:${string}`;
export type ExportKind = "signal" | "broadcast" | "beacon";
/** Deliberately bounded schema subset. Unknown keywords are rejected, not ignored. */
export interface ImageSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, ImageSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ImageSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
}
export interface ImageArtifact {
  platform: { os: "linux" | "darwin" | "win32" | "any"; arch: "amd64" | "arm64" | "any"; abi?: "musl" | "glibc" | "none" };
  runtime: "native" | "node" | "bun";
  /** Required for JS: exact minimum major runtime version, checked before spawning. */
  runtimeMajor?: number;
  digest: Digest;
  size: number;
  /** Display/install filename only; a single basename, never a shell command. */
  entrypoint: string;
}
export interface ImageExport {
  name: string;
  kind: ExportKind;
  inputSchema?: ImageSchema;
  outputSchema?: ImageSchema;
  configSchema?: ImageSchema;
  timeoutMs?: number;
  requiredEnv?: string[];
  /** Declared invocation artifact operations; operator grants are additionally required. */
  artifacts?: { read?: boolean; write?: boolean };
  planner?: "binary";
  mode?: "run" | "poll";
  pollIntervalMs?: number;
  startMode?: "auto" | "on-demand";
}
export interface ImageDependency { image: string; export: string; kind: "signal" | "broadcast" }
export interface NativeSignalDependency { name: string; revision: Digest }
export interface ImageManifest {
  format: typeof IMAGE_FORMAT;
  protocol: typeof PROCESS_PROTOCOL;
  name: string;
  version: string;
  artifacts: ImageArtifact[];
  exports: ImageExport[];
  dependencies?: Record<string, ImageDependency>;
  /** Explicit operator-granted, immutable native Station signal bundles. */
  nativeSignals?: Record<string, NativeSignalDependency>;
  /** Non-secret defaults only. Never place secrets in an image. */
  env?: Record<string, string>;
}
export interface ImageRecord { digest: Digest; manifest: ImageManifest }
export interface HostTarget {
  os: "linux" | "darwin" | "win32";
  arch: "amd64" | "arm64";
  abi?: "musl" | "glibc" | "none";
  runtimes: Partial<Record<"node" | "bun", number>>;
}
export class ImageError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ImageError"; }
}
export function fail(code: string, message: string): never { throw new ImageError(code, message); }
