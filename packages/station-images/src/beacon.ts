import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveImageEnvironment, selectArtifact, validateArtifactBytes } from "./manifest.js";
import { validateValue } from "./schema.js";
import { BeaconProtocolState } from "./protocol.js";
import { fail, ImageError, PROCESS_PROTOCOL, type ImageDependency, type ImageRecord } from "./types.js";
import type { ExecuteImageOptions, ImageProcessBoundary } from "./execution.js";
export interface StartImageBeaconOptions extends Omit<ExecuteImageOptions, "input" | "runId" | "attempt" | "timeoutMs"> {
  config: unknown;
  instanceId: string;
  incarnation: string;
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  pollTimeoutMs?: number;
  stopTimeoutMs?: number;
  onEvent?: (frame: Readonly<Record<string, unknown>>) => void;
  /** Caller must validate dependency input/schema and persist idempotency before enqueueing under its ownership fence. */
  trigger?: (request: { id: string; dependency: ImageDependency; alias: string; input: unknown; instanceId: string; incarnation: string }) => Promise<string>;
}
export interface ImageBeaconSession {
  image: ImageRecord;
  ready: Promise<void>;
  /** Resolves only after a requested stop, protocol acknowledgement and clean exit. */
  done: Promise<void>;
  /** Parent supervisor owns cadence; only one outstanding poll is allowed. */
  poll(id?: string): Promise<void>;
  stop(): Promise<void>;
}
/** Supervise one external beacon incarnation. Durable ownership/restarts remain BeaconRunner's responsibility. */
export async function startImageBeacon(options: StartImageBeaconOptions): Promise<ImageBeaconSession> {
  if ((options.requiredIsolation ?? "container") === "vm" && options.backend.isolation !== "vm" || (options.requiredIsolation ?? "container") === "container" && options.backend.isolation === "trusted-host") fail("isolation_required", "Beacon execution requires an isolated backend");
  if (options.signal?.aborted) fail("cancelled", "Beacon start cancelled");
  for (const id of [options.instanceId, options.incarnation]) if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(id)) fail("invalid_invocation", "Invalid beacon identity");
  const image = await options.registry.resolve(options.reference);
  const exp = image.manifest.exports.find(e => e.name === options.exportName && e.kind === "beacon");
  if (!exp) fail("unknown_export", "Beacon export not found");
  validateValue(exp.configSchema, options.config);
  for (const permission of ["read", "write"] as const) if (options.artifacts?.permissions[permission] && !exp.artifacts?.[permission]) fail("artifact_denied", "Operator artifact grant exceeds export declaration");
  const artifact = selectArtifact(image.manifest, options.backend.target);
  const bytes = await options.registry.getBlob(artifact.digest);
  validateArtifactBytes(artifact, bytes);
  const env = resolveImageEnvironment({ defaults: image.manifest.env, ...options.environment, allowedKeys: options.environment?.allowedKeys ?? [], requiredKeys: exp.requiredEnv });
  const startupMs = options.startupTimeoutMs ?? 10000, heartbeatMs = options.heartbeatTimeoutMs ?? 30000, pollMs = options.pollTimeoutMs ?? exp.timeoutMs ?? 60000, stopMs = options.stopTimeoutMs ?? 3000;
  const maxFrame = options.maxFrameBytes ?? 1024 * 1024, maxOutput = options.maxOutputBytes ?? 4 * 1024 * 1024, maxStderr = options.maxStderrBytes ?? 64 * 1024;
  if ([startupMs, heartbeatMs, pollMs, stopMs].some(v => !Number.isSafeInteger(v) || v < 1 || v > 86400000) || [maxFrame, maxOutput, maxStderr].some(v => !Number.isSafeInteger(v) || v < 1 || v > 16 * 1024 * 1024)) fail("invalid_limits", "Invalid beacon limits");
  const initFrame = { type: "beacon:init", export: exp.name, instanceId: options.instanceId, incarnation: options.incarnation, config: options.config, mode: exp.mode, ...(options.artifacts ? { artifacts: { permissions: options.artifacts.permissions, references: options.artifacts.references, maxChunkBytes: options.artifacts.maxChunkBytes } } : {}) };
  if (Buffer.byteLength(JSON.stringify({ protocol: PROCESS_PROTOCOL, ...initFrame }) + "\n") > maxFrame) fail("input_too_large", "Beacon initialization exceeds frame limit");
  const directory = await mkdtemp(join(tmpdir(), "station-beacon-image-"));
  let boundary: ImageProcessBoundary;
  try { const executablePath = join(directory, artifact.entrypoint); await writeFile(executablePath, bytes, { flag: "wx", mode: artifact.runtime === "native" ? 0o555 : 0o444 }); boundary = await options.backend.spawn({ directory, executablePath, artifact, env }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const state = new BeaconProtocolState(image.manifest, exp.name);
  let failure: ImageError | undefined, closed = false, stopping = false, stopped = false, buffer = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A caller may wait on done before ready. Prevent unhandled rejection without hiding it from explicit await.
  void ready.catch(() => {});
  let killTimer: ReturnType<typeof setTimeout> | undefined, healthTimer: ReturnType<typeof setTimeout> | undefined, stopTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPoll: { id: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  const failSession = (code: string, message: string): void => {
    if (failure || closed) return;
    failure = new ImageError(code, message); readyReject(failure); pendingPoll?.reject(failure);
    void boundary.terminate(false).catch(() => {});
    killTimer = setTimeout(() => { void boundary.terminate(true).catch(() => {}); }, 200);
  };
  const send = (frame: Record<string, unknown>): void => {
    if (closed || failure) return;
    const encoded = JSON.stringify({ protocol: PROCESS_PROTOCOL, ...frame }) + "\n";
    if (Buffer.byteLength(encoded) > maxFrame) { failSession("frame_limit", "Beacon request exceeds limit"); return; }
    boundary.stdin.write(encoded);
  };
  const health = (): void => { if (healthTimer) clearTimeout(healthTimer); healthTimer = setTimeout(() => failSession("heartbeat_timeout", "Beacon heartbeat deadline exceeded"), heartbeatMs); };
  const requests = new Map<string, { serialized: string; promise: Promise<string> }>();
  let activeTriggers = 0;
  let artifactWork = Promise.resolve(), queuedArtifacts = 0;
  const event = (frame: Record<string, unknown>): void => {
    if (frame.type === "artifact:request") {
      if (!options.artifacts || stopping || ++queuedArtifacts > 16) fail("artifact_denied", "Artifact broker unavailable or request concurrency exceeded");
      artifactWork = artifactWork.then(async () => { if (!failure && !closed) send(await options.artifacts!.handle(frame)); })
        .catch(error => failSession(error instanceof ImageError ? error.code : "artifact_io", "Artifact operation rejected"))
        .finally(() => { queuedArtifacts--; });
      return;
    }
    state.accept(frame);
    if (frame.type === "beacon:ready") { clearTimeout(startupTimer); health(); readyResolve(); }
    if (frame.type === "beacon:heartbeat") health();
    if (frame.type === "beacon:stopped") { stopped = true; boundary.stdin.end(); }
    if (frame.type === "beacon:poll-completed" || frame.type === "beacon:poll-failed") {
      if (pendingPoll) {
        clearTimeout(pendingPoll.timer);
        if (frame.type === "beacon:poll-completed") pendingPoll.resolve();
        else pendingPoll.reject(new ImageError("poll_failed", "Beacon poll failed"));
        pendingPoll = undefined;
      }
    }
    if (frame.type === "trigger") {
      const id = frame.id as string, alias = frame.dependency as string;
      if (!options.trigger) { send({ type: "trigger:error", id, error: { code: "dependency_denied", message: "Trigger broker unavailable" } }); return; }
      const serialized = JSON.stringify([alias, frame.input]);
      let request = requests.get(id);
      if (request && request.serialized !== serialized) fail("duplicate_trigger", "Trigger identity reused for different input");
      if (!request) {
        if (requests.size >= 10000 || activeTriggers >= 16) fail("trigger_limit", "Beacon trigger budget exceeded");
        activeTriggers++;
        const promise = Promise.resolve().then(() => options.trigger!({ id, alias, input: frame.input, dependency: image.manifest.dependencies![alias]!, instanceId: options.instanceId, incarnation: options.incarnation })).finally(() => { activeTriggers--; });
        request = { serialized, promise }; requests.set(id, request);
      }
      void request.promise.then(runId => { if (typeof runId !== "string" || !runId || runId.length > 200) throw new Error("Invalid run id"); send({ type: "trigger:result", id, runId }); }).catch(() => send({ type: "trigger:error", id, error: { code: "trigger_rejected", message: "Trigger broker rejected the request" } }));
    }
    try { options.onEvent?.(Object.freeze({ ...frame })); } catch { /* observer cannot disrupt supervision */ }
  };
  const startupTimer = setTimeout(() => failSession("startup_timeout", "Beacon did not become ready"), startupMs);
  // Limit chatter in each minute rather than the whole lifetime of a persistent beacon.
  const budgetTimer = setInterval(() => { stdoutBytes = 0; stderrBytes = 0; }, 60000);
  boundary.stdout.on("data", (chunk: Buffer | string) => {
    if (failure || closed) return;
    const data = Buffer.from(chunk);
    if (!options.artifacts) { stdoutBytes += data.byteLength; if (stdoutBytes > maxOutput) { failSession("output_limit", "Beacon output exceeds minute budget"); return; } }
    buffer = Buffer.concat([buffer, data]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      if (newline > maxFrame) { failSession("frame_limit", "Beacon frame exceeds limit"); return; }
      const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      try { const frame = JSON.parse(line.toString("utf8")); if (options.artifacts && frame.type !== "artifact:request") stdoutBytes += line.byteLength + 1; if (stdoutBytes > maxOutput) fail("output_limit", "Beacon output exceeds minute budget"); event(frame); } catch (error) { failSession(error instanceof ImageError ? error.code : "malformed_protocol", "Beacon emitted invalid protocol data"); return; }
    }
    if (buffer.byteLength > maxFrame) failSession("frame_limit", "Beacon frame exceeds limit");
  });
  boundary.stderr.on("data", (chunk: Buffer | string) => { stderrBytes += Buffer.byteLength(chunk); if (stderrBytes > maxStderr) failSession("stderr_limit", "Beacon logs exceed minute budget"); });
  for (const stream of [boundary.stdout, boundary.stderr, boundary.stdin]) stream.on("error", () => failSession("process_io", "Beacon I/O failed"));
  const abort = (): void => failSession("cancelled", "Beacon incarnation cancelled");
  options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  const done = (async (): Promise<void> => {
    try {
      const exit = await boundary.exited;
      if (failure) throw failure;
      if (exit.code !== 0 || exit.signal !== null || !stopped || buffer.byteLength) fail("beacon_exit", "Beacon exited without a clean stop acknowledgement");
    } catch (error) { readyReject(error as Error); pendingPoll?.reject(error as Error); throw error; }
    finally {
      closed = true; clearTimeout(startupTimer); clearInterval(budgetTimer);
      if (killTimer) clearTimeout(killTimer); if (healthTimer) clearTimeout(healthTimer); if (stopTimer) clearTimeout(stopTimer); if (pendingPoll) clearTimeout(pendingPoll.timer);
      options.signal?.removeEventListener("abort", abort);
      try { await boundary.dispose(); } finally { await artifactWork; await options.artifacts?.close(); await rm(directory, { recursive: true, force: true }); }
    }
  })();
  void done.catch(() => {});
  send(initFrame);
  return {
    image, ready, done,
    async poll(id = randomUUID()): Promise<void> {
      await ready;
      if (failure) throw failure;
      if (closed) fail("invalid_beacon_state", "Beacon incarnation is closed");
      state.beginPoll(id);
      const completion = new Promise<void>((resolve, reject) => { pendingPoll = { id, resolve, reject, timer: setTimeout(() => failSession("poll_timeout", "Beacon poll exceeded deadline"), pollMs) }; });
      send({ type: "beacon:poll", invocationId: id });
      return completion;
    },
    async stop(): Promise<void> {
      if (closed || stopping) return done;
      stopping = true; state.beginStop();
      clearTimeout(startupTimer); if (healthTimer) clearTimeout(healthTimer);
      if (pendingPoll) { clearTimeout(pendingPoll.timer); pendingPoll.reject(new ImageError("cancelled", "Beacon stopped during poll")); pendingPoll = undefined; }
      send({ type: "beacon:stop", deadline: new Date(Date.now() + stopMs).toISOString() });
      stopTimer = setTimeout(() => failSession("stop_timeout", "Beacon did not stop before deadline"), stopMs);
      return done;
    },
  };
}
