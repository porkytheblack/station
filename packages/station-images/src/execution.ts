import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { selectArtifact, resolveImageEnvironment, validateArtifactBytes } from "./manifest.js";
import { validateValue } from "./schema.js";
import { validateBroadcastPlan, validateTerminalFrame, type TerminalFrame } from "./protocol.js";
import { FileImageRegistry } from "./registry.js";
import { fail, ImageError, PROCESS_PROTOCOL, type HostTarget, type ImageArtifact, type ImageRecord } from "./types.js";
export type ImageIsolation = "trusted-host" | "container" | "vm";
export interface ImageProcessSpec {
  /** Host path to a private directory containing ONLY the verified artifact. Mount readonly in isolation. */
  directory: string;
  executablePath: string;
  artifact: ImageArtifact;
  /** Complete approved application env; backend adds only operator-controlled environment. */
  env: Record<string, string>;
}
export interface ImageProcessBoundary {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  /** Resolve when stdout/stderr have closed, not merely when the initial parent process exits. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Terminate the ENTIRE boundary; force=false SIGTERM equivalent; true unconditional kill. Idempotent. */
  terminate(force: boolean): Promise<void>;
  /** Mandatory final cleanup including descendants, even after successful initial-process exit. */
  dispose(): Promise<void>;
}
export interface ImageProcessBackend {
  readonly isolation: ImageIsolation;
  /** OS/arch/ABI/runtime versions of the execution environment (not the controller host). */
  readonly target: HostTarget;
  spawn(spec: ImageProcessSpec): Promise<ImageProcessBoundary>;
}
export interface ExecuteImageOptions {
  registry: FileImageRegistry;
  reference: string;
  exportName: string;
  input: unknown;
  runId: string;
  attempt?: number;
  backend: ImageProcessBackend;
  /** Public callers must require container or vm. Omitted defaults to container-or-VM. */
  requiredIsolation?: ImageIsolation;
  environment?: { store?: Record<string, string>; bindings?: Record<string, string>; overrides?: Record<string, string>; allowedKeys: readonly string[] };
  timeoutMs?: number;
  maxFrameBytes?: number;
  maxOutputBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
}
export interface ImageExecutionResult { image: ImageRecord; exportName: string; output: unknown; stderr: string }
/** One signal invocation or broadcast planning attempt. No scheduling or state mutation occurs here. */
export async function executeImage(options: ExecuteImageOptions): Promise<ImageExecutionResult> {
  const { backend } = options;
  const required = options.requiredIsolation ?? "container";
  if (required === "vm" && backend.isolation !== "vm" || required === "container" && backend.isolation === "trusted-host") fail("isolation_required", "Image execution requires an isolated backend");
  if (options.signal?.aborted) fail("cancelled", "Image invocation cancelled");
  if (typeof options.runId !== "string" || options.runId.length < 1 || options.runId.length > 200 || !Number.isSafeInteger(options.attempt ?? 1) || (options.attempt ?? 1) < 1) fail("invalid_invocation", "Invalid run identity");
  const image = await options.registry.resolve(options.reference);
  const exp = image.manifest.exports.find(e => e.name === options.exportName);
  if (!exp) fail("unknown_export", "Image export not found");
  if (exp.kind === "beacon") fail("beacon_requires_supervisor", "Beacons require a long-lived incarnation supervisor");
  validateValue(exp.inputSchema, options.input);
  const artifact = selectArtifact(image.manifest, backend.target);
  const bytes = await options.registry.getBlob(artifact.digest);
  validateArtifactBytes(artifact, bytes);
  const env = resolveImageEnvironment({ defaults: image.manifest.env, ...options.environment, allowedKeys: options.environment?.allowedKeys ?? [], requiredKeys: exp.requiredEnv });
  const timeoutMs = Math.min(exp.timeoutMs ?? 60000, options.timeoutMs ?? 60000);
  const maxFrame = options.maxFrameBytes ?? 1024 * 1024, maxOutput = options.maxOutputBytes ?? 4 * 1024 * 1024, maxStderr = options.maxStderrBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 || [maxFrame, maxOutput, maxStderr].some(v => !Number.isSafeInteger(v) || v < 1 || v > 16 * 1024 * 1024)) fail("invalid_limits", "Invalid invocation limits");
  const requestObject = { protocol: PROCESS_PROTOCOL, type: "invoke", export: exp.name, runId: options.runId, attempt: options.attempt ?? 1, input: options.input, deadline: new Date(Date.now() + timeoutMs).toISOString() };
  const request = Buffer.from(JSON.stringify(requestObject) + "\n");
  if (request.byteLength > maxFrame) fail("input_too_large", "Invocation request exceeds frame limit");
  const directory = await mkdtemp(join(tmpdir(), "station-image-"));
  let boundary: ImageProcessBoundary | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const executablePath = join(directory, artifact.entrypoint);
    await writeFile(executablePath, bytes, { mode: artifact.runtime === "native" ? 0o555 : 0o444, flag: "wx" });
    boundary = await backend.spawn({ directory, executablePath, artifact, env });
    const child = boundary;
    let terminal: TerminalFrame | undefined, buffer = Buffer.alloc(0), total = 0, stderrSize = 0;
    const stderr: Buffer[] = [];
    let failure: ImageError | undefined;
    const reject = (code: string, message: string): void => {
      if (failure) return;
      failure = new ImageError(code, message);
      void child.terminate(false).catch(() => {});
      killTimer = setTimeout(() => { void child.terminate(true).catch(() => {}); }, 200);
    };
    const onData = (chunk: Buffer | string): void => {
      if (failure) return;
      const data = Buffer.from(chunk); total += data.byteLength;
      if (total > maxOutput) { reject("output_limit", "Process output exceeds limit"); return; }
      buffer = Buffer.concat([buffer, data]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        if (newline > maxFrame) { reject("frame_limit", "Protocol frame exceeds limit"); return; }
        const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
        if (terminal) { reject("duplicate_terminal", "Process emitted more than one terminal frame"); return; }
        try {
          const value: unknown = JSON.parse(line.toString("utf8"));
          validateTerminalFrame(value); terminal = value;
        } catch (error) { reject(error instanceof ImageError ? error.code : "malformed_protocol", "Process emitted invalid protocol data"); return; }
      }
      if (buffer.byteLength > maxFrame) reject("frame_limit", "Protocol frame exceeds limit");
    };
    child.stdout.on("data", onData);
    child.stdout.on("error", () => reject("process_io", "Cannot read process output"));
    child.stderr.on("data", (chunk: Buffer | string) => {
      const data = Buffer.from(chunk); stderrSize += data.byteLength;
      if (stderrSize > maxStderr) { reject("stderr_limit", "Process logs exceed limit"); return; }
      stderr.push(data);
    });
    child.stderr.on("error", () => reject("process_io", "Cannot read process logs"));
    child.stdin.on("error", () => reject("process_io", "Cannot deliver invocation request"));
    timer = setTimeout(() => reject("timeout", "Image invocation exceeded its deadline"), timeoutMs);
    abort = () => reject("cancelled", "Image invocation cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    requestObject.deadline = new Date(Date.now() + timeoutMs).toISOString();
    child.stdin.end(JSON.stringify(requestObject) + "\n");
    const exit = await child.exited;
    if (failure) throw failure;
    if (buffer.byteLength) fail("malformed_protocol", "Process left an unterminated protocol frame");
    if (exit.code !== 0 || exit.signal !== null) fail("process_exit", "Image process did not exit successfully");
    if (!terminal) fail("missing_result", "Image process exited without a terminal frame");
    if (terminal.type === "error") fail("application_error", `Image export reported error ${terminal.error.code}`);
    if (exp.kind === "broadcast") validateBroadcastPlan(terminal.output, image.manifest);
    else validateValue(exp.outputSchema, terminal.output);
    return { image, exportName: exp.name, output: terminal.output, stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (abort) options.signal?.removeEventListener("abort", abort);
    try { await boundary?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
/** Development-only, Unix host-process backend. NOT an untrusted-code isolation boundary. */
export class TrustedLocalProcessBackend implements ImageProcessBackend {
  readonly isolation = "trusted-host" as const;
  readonly target: HostTarget;
  private readonly executables: Partial<Record<"node" | "bun", string>>;
  constructor(options: { allowUnsafeHostExecution: true; target: HostTarget; nodeExecutable?: string; bunExecutable?: string }) {
    if (options.allowUnsafeHostExecution !== true) fail("unsafe_host_denied", "Trusted host execution must be explicitly enabled");
    if (process.platform === "win32") fail("unsupported_backend", "Trusted local backend currently requires POSIX process groups");
    this.target = options.target;
    this.executables = { node: options.nodeExecutable ?? process.execPath, bun: options.bunExecutable };
    for (const path of Object.values(this.executables)) if (path !== undefined && !isAbsolute(path)) fail("invalid_runtime", "Runtime executable must be an operator-approved absolute path");
  }
  async spawn(spec: ImageProcessSpec): Promise<ImageProcessBoundary> {
    const command = spec.artifact.runtime === "native" ? spec.executablePath : this.executables[spec.artifact.runtime];
    if (!command) fail("runtime_unavailable", "Requested runtime executable is not configured");
    const child = spawn(command, spec.artifact.runtime === "native" ? [] : [spec.executablePath], {
      cwd: spec.directory, env: spec.env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", () => reject(new ImageError("spawn_failed", "Cannot start image process")));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const terminate = async (force: boolean): Promise<void> => {
      if (!child.pid) return;
      try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, terminate, dispose: () => terminate(true) };
  }
}
