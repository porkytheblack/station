import { createHash } from "node:crypto";
import { validateEnvKey } from "station-env";
import { assertJson, isRecord, validateSchema } from "./schema.js";
import { fail, IMAGE_FORMAT, PROCESS_PROTOCOL, type Digest, type HostTarget, type ImageArtifact, type ImageManifest } from "./types.js";
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_BLOB_BYTES = 256 * 1024 * 1024;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
export const EXPORT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
export function assertDigest(value: unknown): asserts value is Digest { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail("invalid_digest", "Expected sha256 digest"); }
export function digestBytes(bytes: Uint8Array | string): Digest { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
export function canonicalJson(value: unknown): string {
  assertJson(value);
  const encode = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (isRecord(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return encode(value);
}
export function manifestDigest(manifest: ImageManifest): Digest { validateManifest(manifest); return digestBytes(canonicalJson(manifest)); }
function keys(value: Record<string, unknown>, allowed: string[], what: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("invalid_manifest", `Unknown ${what} field: ${key}`); }
function int(value: unknown, min: number, max: number): boolean { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max; }
function envKey(key: unknown): void {
  const error = validateEnvKey(key);
  if (error || typeof key !== "string" || /^(?:PATH|HOME|SHELL|BASH_ENV|ENV|COMSPEC|PATHEXT|STATION_.*)$/i.test(key)) fail("invalid_environment", "Reserved or invalid application environment key");
}
export function validateManifest(value: unknown): asserts value is ImageManifest {
  assertJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_MANIFEST_BYTES || !isRecord(value)) fail("invalid_manifest", "Manifest must be an object within 256 KiB");
  keys(value, ["format", "protocol", "name", "version", "artifacts", "exports", "dependencies", "env"], "manifest");
  if (value.format !== IMAGE_FORMAT || value.protocol !== PROCESS_PROTOCOL) fail("incompatible_protocol", "Unsupported image format or process protocol");
  if (typeof value.name !== "string" || value.name.length > 200 || !NAME_PATTERN.test(value.name) || value.name.split("/").some(s => s === "." || s === "..")) fail("invalid_manifest", "Invalid image name");
  if (typeof value.version !== "string" || value.version.length > 100 || !VERSION_PATTERN.test(value.version)) fail("invalid_manifest", "Image version must be semantic version");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 32) fail("invalid_manifest", "Image requires 1–32 artifacts");
  const targets = new Set<string>();
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || !isRecord(artifact.platform)) fail("invalid_manifest", "Invalid artifact");
    keys(artifact, ["platform", "runtime", "runtimeMajor", "digest", "size", "entrypoint"], "artifact");
    keys(artifact.platform, ["os", "arch", "abi"], "platform");
    const { os, arch, abi } = artifact.platform;
    if (!["linux", "darwin", "win32", "any"].includes(String(os)) || !["amd64", "arm64", "any"].includes(String(arch)) || abi !== undefined && !["musl", "glibc", "none"].includes(String(abi))) fail("invalid_manifest", "Unsupported platform");
    if (!["native", "node", "bun"].includes(String(artifact.runtime))) fail("invalid_manifest", "Unsupported runtime");
    if (artifact.runtime === "native" && (os === "any" || arch === "any" || artifact.runtimeMajor !== undefined || os === "linux" && abi === undefined)) fail("invalid_manifest", "Native artifacts need concrete OS/architecture and explicit Linux ABI");
    if (artifact.runtime !== "native" && !int(artifact.runtimeMajor, 1, 1000)) fail("invalid_manifest", "JavaScript artifacts require runtimeMajor");
    if (!int(artifact.size, 1, MAX_BLOB_BYTES)) fail("invalid_manifest", "Artifact size exceeds bounds");
    assertDigest(artifact.digest);
    if (typeof artifact.entrypoint !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifact.entrypoint) || artifact.runtime !== "native" && !/\.(?:mjs|cjs|js)$/.test(artifact.entrypoint)) fail("invalid_manifest", "Entrypoint must be a safe executable or JavaScript basename");
    const target = canonicalJson([artifact.platform, artifact.runtime]);
    if (targets.has(target)) fail("invalid_manifest", "Duplicate artifact target");
    targets.add(target);
  }
  if (!Array.isArray(value.exports) || value.exports.length < 1 || value.exports.length > 128) fail("invalid_manifest", "Image requires 1–128 exports");
  const names = new Set<string>();
  for (const exp of value.exports) {
    if (!isRecord(exp)) fail("invalid_manifest", "Invalid export");
    keys(exp, ["name", "kind", "inputSchema", "outputSchema", "configSchema", "timeoutMs", "requiredEnv", "planner", "mode", "pollIntervalMs", "startMode"], "export");
    if (typeof exp.name !== "string" || !EXPORT_PATTERN.test(exp.name) || names.has(exp.name)) fail("invalid_manifest", "Invalid or duplicate export name");
    names.add(exp.name);
    if (!["signal", "broadcast", "beacon"].includes(String(exp.kind))) fail("invalid_manifest", "Unsupported export kind");
    for (const key of ["inputSchema", "outputSchema", "configSchema"]) if (exp[key] !== undefined) validateSchema(exp[key]);
    if (exp.timeoutMs !== undefined && !int(exp.timeoutMs, 1, 86400000)) fail("invalid_manifest", "Invalid timeoutMs");
    if (exp.requiredEnv !== undefined) {
      if (!Array.isArray(exp.requiredEnv) || exp.requiredEnv.length > 128 || new Set(exp.requiredEnv).size !== exp.requiredEnv.length) fail("invalid_environment", "Invalid requiredEnv");
      exp.requiredEnv.forEach(envKey);
    }
    if (exp.kind === "broadcast" && exp.planner !== "binary" || exp.kind !== "broadcast" && exp.planner !== undefined) fail("invalid_manifest", "Broadcast exports require binary planner");
    if (exp.kind === "beacon") {
      if (!["run", "poll"].includes(String(exp.mode)) || exp.startMode !== undefined && !["auto", "on-demand"].includes(String(exp.startMode))) fail("invalid_manifest", "Invalid beacon mode or startMode");
      if (exp.mode === "poll" && !int(exp.pollIntervalMs, 1, 86400000) || exp.mode === "run" && exp.pollIntervalMs !== undefined) fail("invalid_manifest", "Invalid poll interval");
    } else if (exp.mode !== undefined || exp.pollIntervalMs !== undefined || exp.startMode !== undefined || exp.configSchema !== undefined) fail("invalid_manifest", "Beacon-only fields on non-beacon export");
  }
  if (value.dependencies !== undefined) {
    if (!isRecord(value.dependencies) || Object.keys(value.dependencies).length > 128) fail("invalid_manifest", "Invalid dependencies");
    for (const [alias, dependency] of Object.entries(value.dependencies)) {
      if (!EXPORT_PATTERN.test(alias) || names.has(alias) || !isRecord(dependency)) fail("invalid_manifest", "Invalid dependency");
      keys(dependency, ["image", "export", "kind"], "dependency");
      if (typeof dependency.image !== "string" || !/^([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*)@sha256:[0-9a-f]{64}$/.test(dependency.image) || typeof dependency.export !== "string" || !EXPORT_PATTERN.test(dependency.export) || !["signal", "broadcast"].includes(String(dependency.kind))) fail("invalid_manifest", "Dependencies must pin image digest and signal/broadcast export");
    }
  }
  if (value.env !== undefined) {
    if (!isRecord(value.env) || Object.keys(value.env).length > 128) fail("invalid_environment", "Invalid defaults");
    for (const [key, entry] of Object.entries(value.env)) { envKey(key); if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > 32768) fail("invalid_environment", "Invalid environment default"); }
  }
}
export function selectArtifact(manifest: ImageManifest, host: HostTarget): ImageArtifact {
  validateManifest(manifest);
  const matches = manifest.artifacts.filter(a => (a.platform.os === host.os || a.platform.os === "any") && (a.platform.arch === host.arch || a.platform.arch === "any") && (a.platform.abi === undefined || a.platform.abi === "none" || a.platform.abi === host.abi) && (a.runtime === "native" || (host.runtimes[a.runtime] ?? 0) >= a.runtimeMajor!));
  if (!matches.length) fail("incompatible_target", "No artifact supports the selected worker target");
  // Prefer concrete platform declarations, then manifest order. No runtime fallback after launch.
  return matches.sort((a, b) => Number(b.platform.os !== "any") + Number(b.platform.arch !== "any") - Number(a.platform.os !== "any") - Number(a.platform.arch !== "any"))[0]!;
}
export function resolveImageEnvironment(options: { defaults?: Record<string, string>; store?: Record<string, string>; bindings?: Record<string, string>; overrides?: Record<string, string>; allowedKeys: readonly string[]; requiredKeys?: readonly string[]; base?: Record<string, string> }): Record<string, string> {
  const allowed = new Set(options.allowedKeys);
  allowed.forEach(envKey);
  const environment: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(options.base ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) fail("invalid_environment", "Invalid operator base environment");
    environment[key] = value;
  }
  for (const layer of [options.defaults, options.store, options.bindings, options.overrides]) for (const [key, value] of Object.entries(layer ?? {})) {
    envKey(key);
    if (!allowed.has(key)) fail("environment_denied", `Environment key is not granted: ${key}`);
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 32768) fail("invalid_environment", "Invalid environment value");
    environment[key] = value;
  }
  for (const key of options.requiredKeys ?? []) { envKey(key); if (!allowed.has(key) || environment[key] === undefined || environment[key] === "") fail("missing_environment", `Required environment key unavailable: ${key}`); }
  if (Buffer.byteLength(JSON.stringify(environment)) > 256 * 1024) fail("invalid_environment", "Environment exceeds 256 KiB");
  return environment;
}

/** Check stored bytes without executing or dynamically importing an artifact. */
export function validateArtifactBytes(artifact: ImageArtifact, input: Uint8Array): void {
  const bytes = Buffer.from(input);
  if (bytes.length !== artifact.size) fail("size_mismatch", "Artifact size does not match manifest");
  if (digestBytes(bytes) !== artifact.digest) fail("digest_mismatch", "Artifact digest mismatch");
  if (artifact.runtime !== "native") return;
  const invalid = (): never => fail("incompatible_binary", "Native artifact format or architecture does not match its declared target");
  if (artifact.platform.os === "linux") {
    if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[4] !== 2 || bytes[5] !== 1) invalid();
    if (bytes.readUInt16LE(18) !== (artifact.platform.arch === "amd64" ? 62 : 183)) invalid();
  } else if (artifact.platform.os === "darwin") {
    if (bytes.length < 32) invalid();
    const magic = bytes.readUInt32BE(0);
    if (magic !== 0xcffaedfe && magic !== 0xfeedfacf) invalid();
    const cpu = magic === 0xcffaedfe ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4);
    if (cpu !== (artifact.platform.arch === "amd64" ? 0x01000007 : 0x0100000c)) invalid();
  } else if (artifact.platform.os === "win32") {
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") invalid();
    const offset = bytes.readUInt32LE(60);
    if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x00004550 || bytes.readUInt16LE(offset + 4) !== (artifact.platform.arch === "amd64" ? 0x8664 : 0xaa64)) invalid();
  } else invalid();
}
